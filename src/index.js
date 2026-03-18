const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const manifest = require("./manifest");

const engine = require("./sites/engine");
const khmerave = require("./sites/khmerave");
const sites = require("./sites/config");

const axiosClient = require("./utils/fetch");
const cheerio = require("cheerio");
const { normalizePoster, mapMetas, uniqById } = require("./utils/helpers");

const { makeMetaId } = require("./utils/hash");
const { URL_CACHE, EP_CACHE, CATALOG_CACHE } = require("./utils/cache");

function applyMetaId(items, prefix) {
  return items.map(item => {
    const url = item.id || item.url;
    if (typeof url !== "string" || !url.trim()) return null;

    const metaId = makeMetaId(prefix, url);
    URL_CACHE.set(metaId, url);

    return {
      ...item,
      id: metaId
    };
  }).filter(Boolean);
}

const TYPE = "series";

const ENGINES = {
  vip: engine,
  sunday: engine,  
  idrama: engine,
  khmerave,
  merlkon: khmerave
};

function getSiteEngine(id) {
  const site = sites[id];
  const engine = ENGINES[id];

  if (!site || !engine) return null;

  return { site, engine };
}

const builder = new addonBuilder(manifest);

/* =========================
   CATALOG
========================= */
builder.defineCatalogHandler(async ({ id, extra }) => {
  try {
	const cacheKey = `catalog:${id}:${JSON.stringify(extra || {})}`;
    const cached = CATALOG_CACHE.get(cacheKey);
    if (cached) return cached;  
	
	const ctx = getSiteEngine(id);
    if (!ctx) return { metas: [] };

    const { site, engine: siteEngine } = ctx;

    // KhmerAve / Merlkon: search
    if (extra?.search && (id === "khmerave" || id === "merlkon")) {
      const keyword = encodeURIComponent(extra.search);

      const url = id === "merlkon"
        ? `https://www.khmerdrama.com/?s=${keyword}`
        : `https://www.khmeravenue.com/?s=${keyword}`;

      const items = await siteEngine.getCatalogItems(id, site, url);

      const fixed = applyMetaId(items, id);

      const result = { metas: mapMetas(fixed, TYPE) };
      CATALOG_CACHE.set(cacheKey, result);
      return result;
    }

    // KhmerAve / Merlkon: paging
    if (id === "khmerave" || id === "merlkon") {
      const WEBSITE_PAGE_SIZE = site.pageSize || 18;
      const PAGES_PER_BATCH = 2;
      const SKIP_STEP = 300;

      const skip = Number(extra?.skip || 0);

      const startPage =
        Math.floor(skip / SKIP_STEP) *
          PAGES_PER_BATCH +
        1;

      const base = String(site.baseUrl || "").replace(/\/$/, "");
      const pages = [];

      for (let p = startPage; p < startPage + PAGES_PER_BATCH; p++) {
        const url =
          p === 1 ? `${base}/` : `${base}/page/${p}/`;

        pages.push(siteEngine.getCatalogItems(id, site, url));
      }

      const results = await Promise.all(pages);
      const allItems = results.flat();

      if (!allItems.length) return { metas: [] };

      const uniq = uniqById(allItems);

      const fixed = applyMetaId(uniq, id);

	  const result = {
	     metas: mapMetas(
		   fixed.slice(0, WEBSITE_PAGE_SIZE * PAGES_PER_BATCH),
		   TYPE
	     ),
	     cacheMaxAge: 3600
	  };
	  CATALOG_CACHE.set(cacheKey, result);
	  return result;
    }
	
    // SundayDrama (Blogger): search + paging
    if (id === "sunday") {
      const base = String(site.baseUrl || "").replace(/\/$/, "");

      const startUrl = extra?.search
        ? `${base}/search?q=${encodeURIComponent(extra.search)}&max-results=20&m=1`
        : `${base}/?max-results=20&m=1`;

      const WEBSITE_PAGE_SIZE = 20;
      const PAGES_PER_BATCH = 1;

      const skip = Number(extra?.skip || 0);
      const targetPage = Math.floor(skip / WEBSITE_PAGE_SIZE) + 1;

      let url = startUrl;
      let currentPage = 1;
      let allItems = [];

      const headers = {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
        Referer: `${base}/`,
		Accept: "text/html"
      };

      while (currentPage < targetPage && url) {
        const { data } = await axiosClient.get(url, { headers });
        const $ = cheerio.load(data);

        const older =
          $("a.blog-pager-older-link").attr("href") ||
          $("#Blog1_blog-pager-older-link").attr("href") ||
          "";

        url = older ? older : null;
        currentPage++;
      }

      for (let i = 0; i < PAGES_PER_BATCH && url; i++) {
        const { data } = await axiosClient.get(url, { headers });
        const $ = cheerio.load(data);

        const articles = $("article.blog-post").toArray();

        for (const el of articles) {
          const $el = $(el);

          const aImg = $el.find("a.entry-image-wrap").first();
          const link = aImg.attr("href") || $el.find("h2.entry-title a").attr("href") || "";
          const title =
            (aImg.attr("title") || "").trim() ||
            ($el.find("h2.entry-title a").first().text() || "").trim();

          if (!title || !link) continue;

          const img =
            $el.find("img.entry-thumb").attr("src") ||
            aImg.find("span[data-src]").attr("data-src") ||
            aImg.find("img").attr("src") ||
            "";

          allItems.push({
            id: link,
            name: title,
            poster: normalizePoster(img),
          });
        }

        const older =
          $("a.blog-pager-older-link").attr("href") ||
          $("#Blog1_blog-pager-older-link").attr("href") ||
          "";

        url = older ? older : null;
      }

      const uniq = uniqById(allItems);
      const fixed = applyMetaId(uniq, id);

      const result = { metas: mapMetas(fixed, TYPE) };
      CATALOG_CACHE.set(cacheKey, result);
      return result;
    }

    // VIP / iDrama: normal paging
    const pageSize = site.pageSize || 30;
    const skip = Number(extra?.skip || 0);
    const page = Math.floor(skip / pageSize) + 1;

    const base = String(site.baseUrl || "").replace(/\/$/, "");

    const url = extra?.search
      ? `${base}/?s=${encodeURIComponent(extra.search)}`
      : page === 1
        ? `${base}/`
        : `${base}/page/${page}/`;

    const items = await siteEngine.getCatalogItems(id, site, url);

    const fixed = applyMetaId(items, id);

    const result = { metas: mapMetas(fixed, TYPE) };
    CATALOG_CACHE.set(cacheKey, result);
    return result;

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
    const prefix = id.split(":")[0];

    const ctx = getSiteEngine(prefix);
    if (!ctx) return { meta: null };

    const { engine: siteEngine } = ctx;

    const seriesUrl = URL_CACHE.get(id);
    if (!seriesUrl) return { meta: null };

    let episodes = await siteEngine.getEpisodes(prefix, seriesUrl);
    if (!episodes.length) return { meta: null };

    // normalize order
    if (
      episodes.length > 1 && 
	  Number.isFinite(episodes[0]?.episode) &&
	  Number.isFinite(episodes[episodes.length - 1]?.episode) &&
	  episodes[0].episode > episodes[episodes.length - 1].episode
	){
      episodes = episodes.reverse();
    }

    // cache normalized episodes
    EP_CACHE.set(id, episodes);

    const first = episodes[0];

    return {
      meta: {
        id,
        type: TYPE,
        name: (first.title || "KhmerDub").replace(/episode\s*\d+/i, "").trim(),
        poster: first.thumbnail,
        background: first.thumbnail,
        videos: episodes.map((ep, index) => ({
          id: `${id}:${ep.episode}`,
          title: ep.title || `Episode ${ep.episode}`,
		  description: `Episode ${ep.episode}`,
          season: 1,
          episode: ep.episode,
          thumbnail: ep.thumbnail
        })),
      },
    };
  } catch (err) {
    console.error("meta error:", err);
    return { meta: null };
  }
});

/* =========================
   STREAM
========================= */
builder.defineStreamHandler(async ({ id }) => {
  try {
    const parts = id.split(":");
    if (parts.length < 2) return { streams: [] };

    // Extract episode safely
    const episode = parts.pop();
    const metaId = parts.join(":");

    const epNum = Number(episode);
    if (!Number.isInteger(epNum) || epNum <= 0) {
      return { streams: [] };
    }

    const prefix = metaId.split(":")[0];

    const ctx = getSiteEngine(prefix);
    if (!ctx) return { streams: [] };

    const { engine: siteEngine } = ctx;

    const seriesUrl = URL_CACHE.get(metaId);
    if (!seriesUrl) return { streams: [] };

    // =========================
    // USE CACHE FIRST
    // =========================
    let episodes = EP_CACHE.get(metaId);

    if (!episodes) {
      episodes = await siteEngine.getEpisodes(prefix, seriesUrl);
      if (!episodes.length) return { streams: [] };

      // normalize
      if (
        episodes.length > 1 && 
        Number.isFinite(episodes[0]?.episode) &&
        Number.isFinite(episodes[episodes.length - 1]?.episode) &&
        episodes[0].episode > episodes[episodes.length - 1].episode
      ){
        episodes = episodes.reverse();
      }

      EP_CACHE.set(metaId, episodes);
    }

    const ep = episodes[epNum - 1];
    if (!ep) return { streams: [] };

    // Use episode URL directly
    const stream = await siteEngine.getStream(prefix, ep.url, epNum);
    if (!stream) return { streams: [] };

    return { streams: [stream] };

  } catch (err) {
    console.error("stream error:", err);
    return { streams: [] };
  }
});

/* =========================
   START SERVER
========================= */
serveHTTP(builder.getInterface(), {
  port: process.env.PORT || 7000,
});

console.log("KhmerDub Addon running on port", process.env.PORT || 7000);
