const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const manifest = require("./manifest");

const engine = require("./sites/engine");
const khmerave = require("./sites/khmerave");
const sites = require("./sites/config");

const ENGINES = {
  vip: engine,
  sunday: engine,  
  idrama: engine,
  khmerave: khmerave,
  merlkon: khmerave
};

const builder = new addonBuilder(manifest);

/* =========================
   CATALOG
========================= */
builder.defineCatalogHandler(async ({ id, extra }) => {

  try {
    const site = sites[id];
    if (!site) return { metas: [] };

    const siteEngine = ENGINES[id];
    if (!siteEngine) return { metas: [] };

    // KhmerAve / Merlkon: search
    if (extra?.search && (id === "khmerave" || id === "merlkon")) {

      const keyword = encodeURIComponent(extra.search);

      const url = id === "merlkon"
        ? `https://www.khmerdrama.com/?s=${keyword}`
        : `https://www.khmeravenue.com/?s=${keyword}`;

      const items = await siteEngine.getCatalogItems(id, site, url);

      return {
        metas: items.map((item) => ({
          id: item.id,
          type: "series",
          name: item.name,
          poster: item.poster,
          posterShape: "poster",
        })),
      };
    }

    // KhmerAve / Merlkon: paging
    if (id === "khmerave" || id === "merlkon") {

      const WEBSITE_PAGE_SIZE = site.pageSize || 18;
      const PAGES_PER_BATCH = 3;

      const skip = Number(extra?.skip || 0);
      const startPage = Math.floor(skip / WEBSITE_PAGE_SIZE) + 1;

      let allItems = [];

      for (let p = startPage; p < startPage + PAGES_PER_BATCH; p++) {

        const base = String(site.baseUrl || "").replace(/\/$/, "");

        const url = p === 1
          ? `${base}/`
          : `${base}/page/${p}/`;

        const pageItems = await siteEngine.getCatalogItems(id, site, url);
        allItems = allItems.concat(pageItems);
      }

      const uniq = [...new Map(allItems.map((x) => [x.id, x])).values()];

      return {
        metas: uniq.map((item) => ({
          id: item.id,
          type: "series",
          name: item.name,
          poster: item.poster,
          posterShape: "poster",
        })),
      };
    }

    // SundayDrama (Blogger): search + paging
    if (id === "sunday") {
      const axiosClient = require("./utils/fetch");
      const cheerio = require("cheerio");
      const { normalizePoster } = require("./utils/helpers"); 

      const base = String(site.baseUrl || "").replace(/\/$/, "");

      // Blogger search + home URLs
      const startUrl = extra?.search
        ? `${base}/search?q=${encodeURIComponent(extra.search)}&max-results=20`
        : `${base}/?max-results=20`;

      const WEBSITE_PAGE_SIZE = 20;  
      const PAGES_PER_BATCH = 3;

      const skip = Number(extra?.skip || 0);
      const targetIndex = skip;     
      const targetPage = Math.floor(targetIndex / WEBSITE_PAGE_SIZE) + 1;

      // Will page forward using blogger "older posts" / updated-max URLs
      let url = startUrl;
      let currentPage = 1;
      let allItems = [];

      const headers = {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
        Referer: `${base}/`,
      };

      // Aadvance to the target page (best-effort)
      while (currentPage < targetPage && url) {
        const { data } = await axiosClient.get(url, { headers });
        const $ = cheerio.load(data);

        // Blogger older link (sometimes present), else stop
        const older =
          $("a.blog-pager-older-link").attr("href") ||
          $("#Blog1_blog-pager-older-link").attr("href") ||
          "";

        url = older ? older : null;
        currentPage++;
      }

      // Fetch a few pages starting from targetPage
      for (let i = 0; i < PAGES_PER_BATCH && url; i++) {
        const { data } = await axiosClient.get(url, { headers });
        const $ = cheerio.load(data);

        // Sunday cards are <article class="blog-post ..."> ... <a class="entry-image-wrap" title="...">
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
            id: `sunday:${encodeURIComponent(link)}`,
            name: title,
            poster: normalizePoster(img),
          });
        }

        // next page (updated-max / older)
        const older =
          $("a.blog-pager-older-link").attr("href") ||
          $("#Blog1_blog-pager-older-link").attr("href") ||
          "";

        url = older ? older : null;
      }

      const uniq = [...new Map(allItems.map((x) => [x.id, x])).values()];

      return {
        metas: uniq.map((item) => ({
          id: item.id,
          type: "series",
          name: item.name,
          poster: item.poster,
          posterShape: "poster",
        })),
      };
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

    return {
      metas: items.map((item) => ({
        id: item.id,
        type: "series",
        name: item.name,
        poster: item.poster,
        posterShape: "poster",
      })),
    };

  } catch (e) {
    console.error("catalog error:", e?.message || e);
    return { metas: [] };
  }
});

/* =========================
   META
========================= */
builder.defineMetaHandler(async ({ id, type }) => {
  try {

    if (type && type !== "series") return { meta: null };

    console.log("META REQUEST ID:", id);

    const firstColon = id.indexOf(":");
    if (firstColon === -1) return { meta: null };

    const prefix = id.slice(0, firstColon);
    const encodedUrl = id.slice(firstColon + 1);

    console.log("META PREFIX:", prefix);
    console.log("META ENCODED URL:", encodedUrl);

    if (!sites[prefix]) return { meta: null };

    let seriesUrl;

	if (encodedUrl.startsWith("http")) {
	  seriesUrl = encodedUrl;
	} else if (encodedUrl.includes("%")) {
	  seriesUrl = decodeURIComponent(encodedUrl);
	} else {
	  seriesUrl = Buffer.from(encodedUrl, "base64").toString("utf8");
	}

	console.log("META SERIES URL:", seriesUrl);

    const siteEngine = ENGINES[prefix];
    if (!siteEngine) return { meta: null };

    const episodes = await siteEngine.getEpisodes(prefix, seriesUrl);
    if (!episodes.length) return { meta: null };

    const first = episodes[0];

    return {
      meta: {
        id: `${prefix}:${encodeURIComponent(seriesUrl)}`,
        type: "series",
        //name: first.title.replace(/\s*-\s*\[?EP.*$/i, "").trim(),
        poster: first.thumbnail,
        background: first.thumbnail,
        videos: episodes.map(ep => ({
          id: ep.id,
		  type: "episode",
          title: `Episode ${ep.episode}`,
          season: ep.season,
          episode: ep.episode,
		  released: new Date().toISOString()
        }))
      }
    };
  } catch (err) {
    console.error("META ERROR:", err);
    return { meta: null };
  }
});

/* =========================
   STREAM
========================= */
builder.defineStreamHandler(async ({ id }) => {
  try {

    console.log("STREAM REQUEST ID:", id);

    const parts = id.split(":");
    console.log("STREAM PARTS:", parts);

    if (parts.length !== 4) {
      return { streams: [] };
    }

    const prefix = parts[0];
    const encodedUrl = parts[1];
    const episode = parts[3];

    if (!sites[prefix]) return { streams: [] };

    const epNum = Number(episode);
    if (!Number.isInteger(epNum) || epNum <= 0) {
      return { streams: [] };
    }

    const seriesUrl = Buffer.from(encodedUrl, "base64").toString("utf8");

    const siteEngine = ENGINES[prefix];
    if (!siteEngine) return { streams: [] };

    const stream = await siteEngine.getStream(prefix, seriesUrl, epNum);
    if (!stream) return { streams: [] };

    return { streams: [stream] };

  } catch {
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
