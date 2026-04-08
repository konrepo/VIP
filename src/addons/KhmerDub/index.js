const { addonBuilder } = require("stremio-addon-sdk");
const manifest = require("./manifest");

const enabledSites = new Set(
  manifest.catalogs.map(c => c.id)
);

/* =========================
   ENGINES
========================= */
const engine = require("./sites/engine");
const khmerave = require("./sites/khmerave");
const phumi2 = require("./sites/phumi2");
const cat3movie = require("./sites/cat3movie");
const khmertv = require("./sites/khmertv");

const sites = require("./sites/config");
const { normalizePoster, mapMetas, uniqById } = require("./utils/helpers");

/* =========================
   SITE TYPES
========================= */
const SITE_TYPES = {
  cat3movie: "movie",
  khmertv: "movie",
  default: "series"
};

/* =========================
   ENGINE ROUTER
========================= */
const ENGINES = {
  khmertv,
  vip: engine,
  sunday: engine,
  idrama: engine,
  khmerave,
  merlkon: khmerave,
  phumi2,
  cat3movie
};

function getSiteEngine(id) {
  if (!enabledSites.has(id)) return null;

  const site = sites[id];
  const siteEngine = ENGINES[id];

  if (!site || !siteEngine) return null;
  return { site, engine: siteEngine };
}

const builder = new addonBuilder(manifest);

/* =========================
   CATALOG
========================= */
builder.defineCatalogHandler(async ({ id, extra }) => {
  try {
    const ctx = getSiteEngine(id);
    if (!ctx) return { metas: [] };

    const { site, engine: siteEngine } = ctx;

    // KhmerTV (movie)
    if (id === "khmertv") {
      if (Number(extra?.skip || 0) > 0) return { metas: [] };
      const items = await siteEngine.getCatalogItems(id, site, "");
      return { metas: mapMetas(items, "movie") };
    }

    // KhmerAve / Merlkon search
    if (extra?.search && (id === "khmerave" || id === "merlkon")) {
      const keyword = encodeURIComponent(extra.search);
      const url = id === "merlkon"
        ? `https://www.khmerdrama.com/?s=${keyword}`
        : `https://www.khmeravenue.com/?s=${keyword}`;

      const items = await siteEngine.getCatalogItems(id, site, url);
      return { metas: mapMetas(items, SITE_TYPES.default) };
    }

    // KhmerAve / Merlkon paging
    if (id === "khmerave" || id === "merlkon") {
      const PAGE = site.pageSize || 18;
      const BATCH = 3;
      const skip = Number(extra?.skip || 0);
      const start = Math.floor(skip / PAGE) + 1;
      const base = site.baseUrl.replace(/\/$/, "");

      const pages = [];
      for (let p = start; p < start + BATCH; p++) {
        pages.push(
          siteEngine.getCatalogItems(
            id,
            site,
            p === 1 ? `${base}/` : `${base}/page/${p}/`
          )
        );
      }

      const items = uniqById((await Promise.all(pages)).flat());
      return { metas: mapMetas(items, SITE_TYPES.default) };
    }

    // Phumi2 / Cat3Movie
    if (id === "phumi2" || id === "cat3movie") {
      const base = site.baseUrl.replace(/\/$/, "");
      const PAGE = site.pageSize || (id === "cat3movie" ? 40 : 12);
      const BATCH = 3;
      const skip = Number(extra?.skip || 0);
      const target = Math.floor(skip / PAGE) + 1;

      let url = extra?.search
        ? id === "cat3movie"
          ? `${base}/?s=${encodeURIComponent(extra.search)}`
          : `${base}/search?q=${encodeURIComponent(extra.search)}&max-results=12`
        : id === "cat3movie"
          ? `${base}/`
          : `${base}/?max-results=12`;

      let page = 1;
      const all = [];

      while (page < target && url) {
        const html = await siteEngine._fetch(url);
        url = siteEngine.getNextPageUrl(base, html);
        page++;
      }

      for (let i = 0; i < BATCH && url; i++) {
        all.push(...await siteEngine.getCatalogItems(id, site, url));
        const html = await siteEngine._fetch(url);
        url = siteEngine.getNextPageUrl(base, html);
      }

      return { metas: mapMetas(uniqById(all), SITE_TYPES[id] || SITE_TYPES.default) };
    }

    // Default pagination
    const pageSize = site.pageSize || 30;
    const skip = Number(extra?.skip || 0);
    const page = Math.floor(skip / pageSize) + 1;
    const base = site.baseUrl.replace(/\/$/, "");

    const url = extra?.search
      ? `${base}/?s=${encodeURIComponent(extra.search)}`
      : page === 1
        ? `${base}/`
        : `${base}/page/${page}/`;

    const items = await siteEngine.getCatalogItems(id, site, url);
    return { metas: mapMetas(items, SITE_TYPES[id] || SITE_TYPES.default) };

  } catch (e) {
    console.error("catalog error:", e);
    return { metas: [] };
  }
});

/* =========================
   META
========================= */
builder.defineMetaHandler(async ({ id }) => {
  try {
    const parts = id.split(":");
    const prefix = parts[0];
    const siteType = SITE_TYPES[prefix] || SITE_TYPES.default;
    const encodedUrl = parts.slice(1).join(":");

    if (!prefix || !encodedUrl) return { meta: null };

    const ctx = getSiteEngine(prefix);
    if (!ctx) return { meta: null };

    const seriesUrl = decodeURIComponent(encodedUrl);
    const episodes = await ctx.engine.getEpisodes(prefix, seriesUrl);
    if (!episodes.length) return { meta: null };

    const first = episodes[0];

    if (siteType === "movie") {
      return {
        meta: {
          id,
          type: "movie",
          name: first.title,
          poster: first.thumbnail,
          background: first.thumbnail
        }
      };
    }

    return {
      meta: {
        id,
        type: "series",
        name: first.title,
        poster: first.thumbnail,
        background: first.thumbnail,
        videos: episodes
      }
    };
  } catch {
    return { meta: null };
  }
});

/* =========================
   STREAM 
========================= */
builder.defineStreamHandler(async ({ id }) => {
  try {
    const parts = id.split(":");
    const prefix = parts[0];

    const siteType = SITE_TYPES[prefix] || SITE_TYPES.default;
    const isMovie = siteType === "movie";
    const episode = isMovie ? 1 : Number(parts[parts.length - 1]);

    const encodedUrl = isMovie
      ? parts.slice(1).join(":")
      : parts.slice(1, -2).join(":");

    if (!prefix || !encodedUrl || (!isMovie && episode <= 0)) {
      return { streams: [] };
    }

    const ctx = getSiteEngine(prefix);
    if (!ctx) return { streams: [] };

    const seriesUrl = decodeURIComponent(encodedUrl);
    const result = await ctx.engine.getStream(prefix, seriesUrl, episode);

    // New unified engines
    if (result?.streams) return result;

    // Legacy engines (khmerave / phumi2)
    if (result) {
      return { streams: Array.isArray(result) ? result : [result] };
    }

    return { streams: [] };
  } catch (err) {
    console.error("[defineStreamHandler]", err);
    return { streams: [] };
  }
});

module.exports = builder.getInterface();