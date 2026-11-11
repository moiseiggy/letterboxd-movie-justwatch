/**
 * Personal tool: scan a public Letterboxd watchlist/list and sort every film by
 * where you can stream it, starting with the services you already pay for.
 *
 * Talks to JustWatch directly, so no TMDb key is needed.
 *
 * Usage:
 *   bun run watchlist https://letterboxd.com/<user>/watchlist/
 *   bun run watchlist <url> --country US --services "Amazon Prime Video,Netflix" --out report.html
 *
 * Defaults can also come from .env (never committed):
 *   WATCHLIST_SERVICES="Amazon Prime Video,Netflix,Apple TV,Peacock,HBO Max"
 *   WATCHLIST_COUNTRY=US
 *
 * Writes an HTML report (gitignored by default) and prints a plain summary.
 */
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import { getPageFilms } from "../src/server/lib/letterboxdListHtml.js";
import {
  buildLetterboxdHtmlRequestHeaders,
  fetchLetterboxdHtml,
} from "../src/server/lib/letterboxdHttp.js";
import { getRandomScrapeUserAgent } from "../src/server/lib/scrapeUserAgent.js";

const DEFAULT_SERVICES = "Amazon Prime Video,Netflix,Apple TV,Peacock,HBO Max";
const LIBRARY_SERVICES = new Set(["Kanopy", "Hoopla"]);
const MAX_PAGES = 50;
const JUSTWATCH_DELAY_MS = 400;

interface Film {
  title: string;
  year: number | null;
}

interface Offer {
  type: string;
  name: string;
  link: string | null;
}

interface Result {
  film: Film;
  matched?: { title: string; year: number | null; kind: string; url: string };
  yearMismatch?: boolean;
  offers: Offer[];
  error?: string;
}

interface JustWatchNode {
  objectType: string;
  content: { title: string; originalReleaseYear: number | null; fullPath: string };
  offers: {
    monetizationType: string;
    standardWebURL: string | null;
    package: { clearName: string };
  }[];
}

const JW_QUERY = `query Q($country: Country!, $language: Language!, $first: Int!, $filter: TitleFilter) {
  popularTitles(country: $country, first: $first, filter: $filter) { edges { node {
    objectType
    content(country: $country, language: $language) { title originalReleaseYear fullPath }
    offers(country: $country, platform: WEB) { monetizationType standardWebURL package { clearName } }
  } } } }`;

function parseArgs(argv: string[]): {
  listUrl: string;
  country: string;
  services: string[];
  out: string;
} {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
    else positional.push(a);
  }
  const listUrl = positional[0];
  if (!listUrl || !/^https:\/\/letterboxd\.com\/[^/]+\/(watchlist|list\/[^/]+)\/?$/.test(listUrl)) {
    console.error(
      'Usage: bun run watchlist https://letterboxd.com/<user>/watchlist/ [--country US] [--services "A,B"] [--out file.html]',
    );
    process.exit(1);
  }
  return {
    listUrl: listUrl.endsWith("/") ? listUrl : `${listUrl}/`,
    country: (flags.country || process.env.WATCHLIST_COUNTRY || "US").toUpperCase(),
    services: (flags.services || process.env.WATCHLIST_SERVICES || DEFAULT_SERVICES)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    out: flags.out || "watchlist-report.html",
  };
}

async function fetchList(listUrl: string): Promise<Film[]> {
  const headers = buildLetterboxdHtmlRequestHeaders(getRandomScrapeUserAgent());
  const films = new Map<string, Film>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? listUrl : `${listUrl}page/${page}/`;
    const html = await fetchLetterboxdHtml(url, headers);
    const pageFilms = getPageFilms(cheerio.load(html));
    const before = films.size;
    for (const f of pageFilms) {
      if (!f.title) continue;
      films.set(f.link || `${f.title}|${f.year}`, {
        title: f.title,
        year: f.year ? Number(f.year) : null,
      });
    }
    // Past the last page Letterboxd returns an empty grid (or repeats); stop there.
    if (films.size === before) break;
    console.log(`  page ${page}: ${films.size} titles so far`);
  }
  return [...films.values()];
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function lookup(film: Film, country: string): Promise<Result> {
  try {
    const res = await fetch("https://apis.justwatch.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": getRandomScrapeUserAgent() },
      body: JSON.stringify({
        query: JW_QUERY,
        variables: { country, language: "en", first: 6, filter: { searchQuery: film.title } },
      }),
    });
    if (!res.ok) return { film, offers: [], error: `JustWatch HTTP ${res.status}` };
    const json = (await res.json()) as {
      data?: { popularTitles?: { edges?: { node: JustWatchNode }[] } };
    };
    const nodes = (json.data?.popularTitles?.edges ?? []).map((e) => e.node);
    const sameTitle = nodes.filter((n) => norm(n.content.title) === norm(film.title));
    const closeYear = sameTitle.find(
      (n) =>
        film.year === null ||
        n.content.originalReleaseYear === null ||
        Math.abs(n.content.originalReleaseYear - film.year) <= 1,
    );
    const match = closeYear ?? sameTitle[0];
    if (!match) return { film, offers: [], error: "not found on JustWatch" };
    return {
      film,
      matched: {
        title: match.content.title,
        year: match.content.originalReleaseYear,
        kind: match.objectType === "SHOW" ? "series" : "film",
        url: `https://www.justwatch.com${match.content.fullPath}`,
      },
      yearMismatch: !closeYear,
      offers: match.offers.map((o) => ({
        type: o.monetizationType,
        name: o.package.clearName,
        link: o.standardWebURL,
      })),
    };
  } catch (err) {
    return { film, offers: [], error: String(err) };
  }
}

/** Collapse "Netflix Standard with Ads" etc. into one entry per base service. */
function baseName(name: string): string {
  return name.replace(/\s+(Standard\s+)?with Ads$/i, "").replace(/\s+Free with Ads$/i, "");
}

function isAddOnChannel(name: string): boolean {
  return /channel/i.test(name);
}

/**
 * Index of the user's service this offer belongs to, or -1. Matches the exact name
 * or a tier of it ("Peacock" matches "Peacock Premium" and "Peacock Premium Plus"),
 * but never add-on channels or rental stores ("Apple TV Store", "HBO Max Amazon Channel").
 */
function serviceIndex(name: string, services: string[]): number {
  if (isAddOnChannel(name) || /\bstore\b/i.test(name)) return -1;
  const n = baseName(name).toLowerCase();
  return services.findIndex((s) => {
    const want = s.toLowerCase();
    return n === want || n.startsWith(`${want} `);
  });
}

type Tier = "mine" | "free" | "other" | "none" | "unconfirmed";

interface Placement {
  tier: Tier;
  where: Offer[];
  note?: string;
}

function place(r: Result, services: string[]): Placement {
  if (r.error || !r.matched) return { tier: "unconfirmed", where: [], note: r.error };
  if (r.yearMismatch) {
    return {
      tier: "unconfirmed",
      where: [],
      note: `JustWatch only matched ${r.matched.title} (${r.matched.year}), which may be a different title`,
    };
  }
  const subscriptionNames = new Set(
    r.offers.filter((o) => o.type === "FLATRATE").map((o) => baseName(o.name)),
  );
  const dedupe = (offers: Offer[]): Offer[] => {
    const seen = new Set<string>();
    return offers.filter((o) => {
      const key = baseName(o.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  // One entry per preferred service, in the order the user listed them.
  const mineByService = new Map<number, Offer>();
  for (const o of r.offers) {
    if (!["FLATRATE", "ADS", "FREE"].includes(o.type)) continue;
    const idx = serviceIndex(o.name, services);
    if (idx >= 0 && !mineByService.has(idx)) mineByService.set(idx, o);
  }
  const mine = [...mineByService.entries()].sort(([a], [b]) => a - b).map(([, o]) => o);
  if (mine.length) return { tier: "mine", where: mine };

  const free = dedupe(
    r.offers.filter(
      (o) =>
        (o.type === "ADS" || o.type === "FREE") &&
        !LIBRARY_SERVICES.has(o.name) &&
        !subscriptionNames.has(baseName(o.name)),
    ),
  );
  const library = dedupe(r.offers.filter((o) => LIBRARY_SERVICES.has(o.name)));
  if (free.length || library.length) {
    return {
      tier: "free",
      where: free.length ? free : library,
      note:
        free.length && library.length
          ? `also free with a library card on ${library.map((o) => o.name).join(", ")}`
          : library.length
            ? "needs a library card"
            : undefined,
    };
  }

  const subs = r.offers.filter((o) => o.type === "FLATRATE");
  const other = dedupe(subs.filter((o) => !isAddOnChannel(o.name)));
  const otherOrChannels = other.length ? other : dedupe(subs);
  if (otherOrChannels.length) return { tier: "other", where: otherOrChannels };

  const types = new Set(r.offers.map((o) => o.type));
  const note = types.has("CINEMA")
    ? "in theaters only"
    : types.has("RENT")
      ? "rent or buy only"
      : types.has("BUY")
        ? "buy only (digital or disc)"
        : "no options listed";
  return { tier: "none", where: [], note };
}

const esc = (s: string | null | undefined): string =>
  (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function label(r: Result): string {
  const year = r.film.year ?? r.matched?.year ?? "";
  const kind = r.matched?.kind === "series" ? ", series" : "";
  return `${r.film.title} (${year}${kind})`;
}

const TIERS: { tier: Tier; heading: string; color: string }[] = [
  { tier: "mine", heading: "1. Start here: already on your services", color: "#e8f5e9" },
  { tier: "free", heading: "2. Free, no subscription", color: "#e3f2fd" },
  { tier: "other", heading: "3. Needs a service you didn't list", color: "#fff3e0" },
  { tier: "none", heading: "4. Not streaming right now", color: "#f2f2f2" },
  { tier: "unconfirmed", heading: "5. Couldn't confirm", color: "#f2f2f2" },
];

function renderHtml(
  rows: { r: Result; p: Placement }[],
  opts: { listUrl: string; country: string; services: string[] },
): string {
  const date = new Date().toISOString().slice(0, 10);
  const sections = TIERS.map(({ tier, heading, color }) => {
    const items = rows.filter((x) => x.p.tier === tier);
    if (!items.length) return "";
    const lis = items
      .map(({ r, p }) => {
        const links = p.where
          .map((o) =>
            o.link
              ? `<a href="${esc(o.link)}">${esc(baseName(o.name))}</a>`
              : esc(baseName(o.name)),
          )
          .join(", ");
        const jw = r.matched
          ? ` <a href="${esc(r.matched.url)}" style="color:#999;font-size:12px">JustWatch</a>`
          : "";
        const note = p.note ? ` <span style="color:#777">(${esc(p.note)})</span>` : "";
        return `<li><b>${esc(label(r))}</b>${links ? `: ${links}` : ""}${note}${jw}</li>`;
      })
      .join("\n");
    return `<h3 style="background:${color};padding:8px 12px;border-radius:6px;margin:24px 0 8px">${heading} (${items.length})</h3>\n<ul style="padding-left:20px">${lis}</ul>`;
  }).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Watchlist streaming report</title></head>
<body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:680px;margin:24px auto;padding:0 16px;color:#1c1c1e;line-height:1.5">
<h2 style="margin:0 0 4px">Where to stream your watchlist</h2>
<p style="margin:0;color:#666;font-size:14px">${rows.length} titles from <a href="${esc(opts.listUrl)}">${esc(opts.listUrl)}</a>, checked against JustWatch (${esc(opts.country)}) on ${date}.<br>Your services: ${esc(opts.services.join(", "))}.</p>
${sections}
</body></html>`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`Reading ${opts.listUrl} ...`);
  const films = await fetchList(opts.listUrl);
  if (!films.length) {
    console.error("No films found. Is the list public?");
    process.exit(1);
  }
  console.log(`Found ${films.length} titles. Checking JustWatch (${opts.country}) ...`);

  const rows: { r: Result; p: Placement }[] = [];
  for (const film of films) {
    const r = await lookup(film, opts.country);
    rows.push({ r, p: place(r, opts.services) });
    await new Promise((res) => setTimeout(res, JUSTWATCH_DELAY_MS));
  }

  await writeFile(opts.out, renderHtml(rows, opts));

  for (const { tier, heading } of TIERS) {
    const items = rows.filter((x) => x.p.tier === tier);
    if (!items.length) continue;
    console.log(`\n${heading}`);
    for (const { r, p } of items) {
      const where = p.where.map((o) => baseName(o.name)).join(", ");
      console.log(`  ${label(r)}${where ? `: ${where}` : ""}${p.note ? ` (${p.note})` : ""}`);
    }
  }
  console.log(`\nReport written to ${opts.out}`);
}

await main();
