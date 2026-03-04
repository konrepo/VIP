const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const cheerio = require("cheerio");
const axios = require("axios");

const BASE_URL = "https://phumikhmer.vip";

const BLOG_IDS = {
  TVSABAY: "8016412028548971199",
  ONELEGEND: "596013908374331296",
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

const axiosClient = axios.create({
  headers: { "User-Agent": USER_AGENT },
  timeout: 15000,
});

/* =========================
   UTIL
========================= */
function normalizePoster(url) {
  if (!url) return "";
  return url
    .replace(/\/s\d+\//, "/s0/")
    .replace(/=s\d+/, "=s0");
}

function extractVideoLinks(text) {
  const regex =
    /https?:\/\/[^\s"';<> ]+\.(?:m3u8|mp4)(?:\?[^\s"';<> ]+)?/gi;
  const matches = text.match(regex);
  return matches ? Array.from(new Set(matches)) : [];
}

async function getPostId(url) {
  const { data } = await axiosClient.get(url);
  const $ = cheerio.load(data);
  return $("div#player").attr("data-post-id") || null;
}

/* =========================
   BLOGGER FETCH 
========================= */

async function fetchFromBlog(blogId, postId) {
  const feedUrl = `https://www.blogger.com/feeds/${blogId}/posts/default/${postId}?alt=json`;

  try {
    const { data } = await axiosClient.get(feedUrl);

    const title = data.entry.title.$t;
    const thumbnail = data.entry.media$thumbnail?.url || "";
    const year =
      parseInt(data.entry.published.$t.slice(0, 4)) ||
      new Date().getFullYear();

    const urls = extractVideoLinks(data.entry.content.$t);

    if (!urls.length) return null;

    return { title, thumbnail, year, urls };
  } catch {
    return null;
  }
}

async function getStreamDetail(postId) {
  // Try ONELEGEND first
  let detail = await fetchFromBlog(BLOG_IDS.ONELEGEND, postId);

  // Fallback to TVSABAY
  if (!detail) {
    detail = await fetchFromBlog(BLOG_IDS.TVSABAY, postId);
  }

  return detail;
}

/* =========================
   SCRAPE CATALOG
========================= */

async function getItems(url) {
  const { data } = await axiosClient.get(url);
  const $ = cheerio.load(data);

  const articles = $("article").toArray();
  const results = [];

  for (const el of articles) {
    const $el = $(el);
    const a = $el.find("h2 a, h3 a").first();
    const img = $el.find("img").first();

    const title = a.text().trim();
    const link = a.attr("href");
    if (!title || !link) continue;

    const poster =
      $el.find("a.img-holder").attr("data-src") ||
      $el.find("a.img-holder").attr("data-bsrjs") ||
      "";

    try {
      const postId = await getPostId(link);
      if (postId) {
        results.push({
          id: postId,
          name: title,
          poster: normalizePoster(poster),
        });
      }
    } catch {
      continue;
    }
  }

  return results;
}

async function getEpisodes(postId) {
  const detail = await getStreamDetail(postId);
  if (!detail) return [];

  return detail.urls.map((url, index) => ({
    id: `vip:${postId}:${index + 1}`,
    title: detail.title,
    season: 1,
    episode: index + 1,
    thumbnail: normalizePoster(detail.thumbnail),
    released: new Date().toISOString()
  }));
}

/* =========================
   STREMIO MANIFEST
========================= */

const manifest = {
  id: "community.khmer.vip",
  version: "1.0.0",
  name: "Khmer VIP",
  description: "Khmer VIP Blogger Streams",
  resources: ["catalog", "meta", "stream"],
  types: ["series"],
  catalogs: [
    {
      type: "series",
      id: "vip",
      name: "VIP Latest",
      extraSupported: ["search", "skip"],
    },
  ],
};

const builder = new addonBuilder(manifest);

/* =========================
   CATALOG
========================= */

builder.defineCatalogHandler(async ({ extra }) => {
  try {
    const page = extra?.skip
      ? Math.ceil(extra.skip / 30) + 1
      : 1;

    const url =
      page === 1
        ? BASE_URL
        : `${BASE_URL}/page/${page}/`;

    const items = await getItems(url);

    let metas = items.map((item) => ({
      id: item.id,
      type: "series",
      name: item.name,
      poster: item.poster,
      posterShape: "poster",
    }));

    if (extra?.search) {
      const search = extra.search.toLowerCase();
      metas = metas.filter((m) =>
        m.name.toLowerCase().includes(search)
      );
    }

    return { metas };
  } catch {
    return { metas: [] };
  }
});

/* =========================
   META
========================= */

builder.defineMetaHandler(async ({ id }) => {
  try {
    const episodes = await getEpisodes(id);
    if (!episodes.length) return { meta: null };

    const first = episodes[0];

    return {
      meta: {
        id: id,
        type: "series",
        name: first.title,
        poster: normalizePoster(first.thumbnail),
        background: normalizePoster(first.thumbnail),
        videos: episodes,
      },
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
    const postId = parts[1];
    const episode = parseInt(parts[2]);

    const detail = await getStreamDetail(postId);
    if (!detail) return { streams: [] };

    const url = detail.urls[episode - 1];
    if (!url) return { streams: [] };

    return {
      streams: [
        {
          url,
          name: "KhmerVIP",
          title: `Episode ${episode}`,
          behaviorHints: {
            notWebReady: true,
            group: "khmervip",
          },
        },
      ],
    };
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

console.log("Khmer VIP Addon running");
