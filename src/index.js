const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const manifest = require("./manifest");

const engine = require("./sites/engine");
const khmerave = require("./sites/khmerave");
const sites = require("./sites/config");

const axiosClient = require("./utils/fetch");
const cheerio = require("cheerio");
const { normalizePoster, mapMetas, uniqById } = require("./utils/helpers");

const { EP_CACHE, CATALOG_CACHE } = require("./utils/cache");

const TYPE = "series";

const ENGINES = {
  vip: engine,
  sunday: engine,
  idrama: engine,
  khmerave,
  merlkon: khmerave,
};

function encodeMetaId(prefix, url) {
  const encoded = Buffer.from(String(url).trim(), "utf8").toString("base64url");
  return `${prefix}:${encoded}`;
}

function decodeMetaId(id) {
  const raw = String(id || "");
  const idx = raw.indexOf(":");
  if (idx === -1) return null;

  const prefix = raw.slice(0, idx);
  const encoded = raw.slice(idx + 1);

  // Reject old md5-style IDs from previous addon versions
  if (/^[a-f0-9]{32}$/i.test(encoded)) {
    return null;
  }

  try {
    const url = Buffer.from(encoded, "base64url").toString("utf8").trim();

    if (!/^https?:\/\//i.test(url)) {
      return null;
    }

    return { prefix, url };
  } catch {
    return null;
  }
}

function applyMetaId(items, prefix) {
  return items
    .map((item) => {
      const url = item.id || item.url;
      if (typeof url !== "string" || !url.trim()) return null;

      return {
        ...item,
        id: encodeMetaId(prefix, url),
      };
    })
    .filter(Boolean);
}

function getSiteEngine(id) {
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
    console.log("[CATALOG REQUEST]", { id, extra });

    const cacheKey = `catalog:${id}:${JSON.stringify(extra || {})}`;
    const cached = CATALOG_CACHE.get(cacheKey);
    if (cached) return cached;

    const ctx = getSiteEngine(id);
    if (!ctx) return { metas: [] };

    const { site, engine: siteEngine } = ctx;

    // KhmerAve / Merlkon: search
    if (extra?.search && (id === "khmerave" || id === "merlkon")) {
      const keyword = encodeURIComponent(extra.search);

      const url =
        id === "merlkon"
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
      const PAGES_PER_BATCH = 3;
      const skip = Number(extra?.skip || 0);

      const startPage = Math.floor(skip / WEBSITE_PAGE_SIZE) + 1;
      const base = String(site.baseUrl || "").replace(/\/$/, "");
      const pages = [];

      for (let p = startPage; p < startPage + PAGES_PER_BATCH; p++) {
        const url = p === 1 ? `${base}/` : `${base}/page/${p}/`;
        pages.push(siteEngine.getCatalogItems(id, site, url));
      }

      const results = await Promise.all(pages);
      const allItems = results.flat();

      if (!allItems.length) return { metas: [] };

      const uniq = uniqById(allItems);
      const fixed = applyMetaId(uniq, id);

      const offset = skip - (startPage - 1) * WEBSITE_PAGE_SIZE;

      const result = {
        metas: mapMetas(
          fixed.slice(offset, offset + WEBSITE_PAGE_SIZE),
          TYPE
        ),
        cacheMaxAge: 3600,
      };

      CATALOG_CACHE.set(cacheKey, result);
      return result;
    }

    // SundayDrama (Blogger): search + paging
    if (id === "sunday") {
      const base = String(site.baseUrl || "").replace(/\/$/, "");

      const startUrl = extra?.search
        ? `${base}/search?q=${encodeURIComponent(extra.search)}&max-results=20`
        : `${base}/?max-results=20`;

      const WEBSITE_PAGE_SIZE = 20;
      const PAGES_PER_BATCH = 3;
      const skip = Number(extra?.skip || 0);

      const targetPage = Math.floor(skip / WEBSITE_PAGE_SIZE) + 1;

      let url = startUrl;
      let currentPage = 1;
      let allItems = [];

      const headers = {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
        Referer: `${base}/`,
      };

      while (currentPage < targetPage && url) {
        const { data } = await axiosClient.get(url, { headers });
        const $ = cheerio.load(data);

        const older =
          $("a.blog-pager-older-link").attr("href") ||
          $("#Blog1_blog-pager-older-link").attr("href") ||
          "";

        url = older || null;
        currentPage++;
      }

      for (let i = 0; i < PAGES_PER_BATCH && url; i++) {
        const { data } = await axiosClient.get(url, { headers });
        const $ = cheerio.load(data);

        const articles = $("article.blog-post").toArray();

        for (const el of articles) {
          const $el = $(el);

          const aImg = $el.find("a.entry-image-wrap").first();
          const link =
            aImg.attr("href") ||
            $el.find("h2.entry-title a").attr("href") ||
            "";

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

        url = older || null;
      }

      if (!allItems.length) return { metas: [] };

      const uniq = uniqById(allItems);
      const fixed = applyMetaId(uniq, id);

      const offset = skip - (targetPage - 1) * WEBSITE_PAGE_SIZE;

      const result = {
        metas: mapMetas(
          fixed.slice(offset, offset + WEBSITE_PAGE_SIZE),
          TYPE
        ),
        cacheMaxAge: 3600,
      };

      CATALOG_CACHE.set(cacheKey, result);
      return result;
    }

    // VIP / iDrama: normal paging
    const WEBSITE_PAGE_SIZE = site.pageSize || 30;
    const PAGES_PER_BATCH = 3;
    const skip = Number(extra?.skip || 0);

    const startPage = Math.floor(skip / WEBSITE_PAGE_SIZE) + 1;
    const base = String(site.baseUrl || "").replace(/\/$/, "");
    const pages = [];

    for (let p = startPage; p < startPage + PAGES_PER_BATCH; p++) {
      const url = extra?.search
        ? `${base}/?s=${encodeURIComponent(extra.search)}&paged=${p}`
        : p === 1
          ? `${base}/`
          : `${base}/page/${p}/`;

      pages.push(siteEngine.getCatalogItems(id, site, url));
    }

    const results = await Promise.all(pages);
    const allItems = results.flat();

    if (!allItems.length) return { metas: [] };

    const uniq = uniqById(allItems);
    const fixed = applyMetaId(uniq, id);

    const offset = skip - (startPage - 1) * WEBSITE_PAGE_SIZE;

    const result = {
      metas: mapMetas(
        fixed.slice(offset, offset + WEBSITE_PAGE_SIZE),
        TYPE
      ),
      cacheMaxAge: 3600,
    };

    CATALOG_CACHE.set(cacheKey, result);
    return result;
  } catch (e) {
    console.error("[catalog error]", {
      id,
      extra,
      message: e.message,
      status: e.response?.status || null,
    });
    return { metas: [] };
  }
});

/* =========================
   META
========================= */
builder.defineMetaHandler(async ({ id }) => {
  try {
    console.log("[META REQUEST]", { id });

    const decoded = decodeMetaId(id);
    if (!decoded) {
      console.error("[META decode failed]", {
        id,
        reason: "Old cached ID or invalid encoded URL. Remove and re-add addon in Stremio.",
      });
      return { meta: null };
    }

    const { prefix, url: seriesUrl } = decoded;

    const ctx = getSiteEngine(prefix);
    if (!ctx) return { meta: null };

    const { engine: siteEngine } = ctx;

    let episodes;

    if (prefix === "khmerave" || prefix === "merlkon") {
      episodes = await khmerave.getEpisodes(prefix, seriesUrl);
    } else {
      episodes = await siteEngine.getEpisodes(prefix, seriesUrl);
    }

    if (!episodes.length) return { meta: null };

    if (
      episodes.length > 1 &&
      Number.isFinite(episodes[0]?.episode) &&
      Number.isFinite(episodes[episodes.length - 1]?.episode) &&
      episodes[0].episode > episodes[episodes.length - 1].episode
    ) {
      episodes = episodes.reverse();
    }

    EP_CACHE.set(id, episodes);

    const first = episodes[0];

    return {
      meta: {
        id,
        type: TYPE,
        name: (first.title || "KhmerDub")
          .replace(/\[.*?\]/g, "")
          .replace(/-\s*$/, "")
          .trim(),
        description: (first.title || "KhmerDub")
          .replace(/\[.*?\]/g, ""),
        poster: first.thumbnail,
        background: first.thumbnail,
        videos: episodes.map((ep) => ({
          id: `${id}:${ep.episode}`,
          title: ep.title || `Episode ${ep.episode}`,
          description: `Episode ${ep.episode}`,
          season: 1,
          episode: ep.episode,
          thumbnail: ep.thumbnail,
        })),
      },
    };
  } catch (err) {
    console.error("[meta error]", {
      id,
      message: err.message,
      status: err.response?.status || null,
    });
    return { meta: null };
  }
});

/* =========================
   STREAM
========================= */
builder.defineStreamHandler(async ({ id }) => {
  try {
    console.log("[STREAM REQUEST]", { id });

    const lastColon = String(id || "").lastIndexOf(":");
    if (lastColon === -1) return { streams: [] };

    const metaId = id.slice(0, lastColon);
    const episode = id.slice(lastColon + 1);

    const epNum = Number(episode);
    if (!Number.isInteger(epNum) || epNum <= 0) {
      return { streams: [] };
    }

    const decoded = decodeMetaId(metaId);
    if (!decoded) {
      console.error("[STREAM decode failed]", {
        id,
        metaId,
        reason: "Old cached ID or invalid encoded URL. Remove and re-add addon in Stremio.",
      });
      return { streams: [] };
    }

    const { prefix, url: seriesUrl } = decoded;

    const ctx = getSiteEngine(prefix);
    if (!ctx) return { streams: [] };

    const { engine: siteEngine } = ctx;

    let episodes = EP_CACHE.get(metaId);

    if (!episodes) {
      if (prefix === "khmerave" || prefix === "merlkon") {
        episodes = await khmerave.getEpisodes(prefix, seriesUrl);
      } else {
        episodes = await siteEngine.getEpisodes(prefix, seriesUrl);
      }

      if (!episodes.length) return { streams: [] };

      if (
        episodes.length > 1 &&
        Number.isFinite(episodes[0]?.episode) &&
        Number.isFinite(episodes[episodes.length - 1]?.episode) &&
        episodes[0].episode > episodes[episodes.length - 1].episode
      ) {
        episodes = episodes.reverse();
      }

      EP_CACHE.set(metaId, episodes);
    }

    let ep = episodes.find((e) => e.episode === epNum);
    if (!ep && epNum - 1 >= 0 && epNum - 1 < episodes.length) {
      ep = episodes[epNum - 1];
    }
    if (!ep) return { streams: [] };

    let stream;

    if (prefix === "khmerave" || prefix === "merlkon") {
      stream = await khmerave.getStream(prefix, ep.url, ep.episode);
    } else {
      stream = await siteEngine.getStream(prefix, ep.url, epNum);
    }

    if (!stream) return { streams: [] };

    return { streams: [stream] };
  } catch (err) {
    console.error("[stream error]", {
      id,
      message: err.message,
      status: err.response?.status || null,
    });
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