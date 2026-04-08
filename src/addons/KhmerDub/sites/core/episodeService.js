const axiosClient = require("../../utils/fetch");
const cheerio = require("cheerio");

const { resolvePost } = require("./postResolver");
const bloggerEngine = require("./bloggerEngine");
const wordpressEngine = require("./wordpressEngine");
const { BLOG_IDS } = require("../../utils/cache");

/* =========================
   MAIN ENTRY
========================= */
async function getEpisodes(prefix, seriesUrl) {
  const { postId, info } = await resolvePost(seriesUrl);

  /* =========================
     BLOGGER SERIES
  ========================= */
  if (info?.sourceType === "blogger" && postId) {
    const episodes = [];

    for (const blogId of Object.values(BLOG_IDS)) {
      const detail = await bloggerEngine.fetchFromBlog(blogId, postId);
      if (!detail?.urls?.length) continue;

      detail.urls.forEach((_, idx) => {
        episodes.push({
          id: `${prefix}:${encodeURIComponent(seriesUrl)}:1:${idx + 1}`,
          title: detail.title || `Episode ${idx + 1}`,
          season: 1,
          episode: idx + 1,
          thumbnail: detail.thumbnail || "",
          released: new Date().toISOString()
        });
      });

      if (episodes.length) return episodes;
    }
  }

  /* =========================
     WORDPRESS SERIES
  ========================= */
  if (info?.sourceType === "wordpress" && postId) {
    const detail = await wordpressEngine.fetchWordpressDetail(
      seriesUrl,
      postId
    );

    if (detail?.urls?.length) {
      return detail.urls.map((_, idx) => ({
        id: `${prefix}:${encodeURIComponent(seriesUrl)}:1:${idx + 1}`,
        title: detail.title || `Episode ${idx + 1}`,
        season: 1,
        episode: idx + 1,
        thumbnail: detail.thumbnail || "",
        released: new Date().toISOString()
      }));
    }
  }

  /* =========================
     EXTERNAL EPISODE LINKS 
     e.g. nizu.top / kolabkhmer.com
  ========================= */
  const externalEpisodes = await extractExternalEpisodes(prefix, seriesUrl);
  if (externalEpisodes.length) return externalEpisodes;

  return [];
}

/* =========================
   EXTERNAL EPISODE EXTRACTOR
========================= */
async function extractExternalEpisodes(prefix, seriesUrl) {
  try {
    const { data } = await axiosClient.get(seriesUrl, {
      headers: { Referer: seriesUrl }
    });

    const $ = cheerio.load(data);

    // Detect NIZU series link
    const nizuSeries =
      $("a[href*='nizu.top/series/']").first().attr("href");

    if (!nizuSeries) return [];

    // Fetch NIZU series page
    const { data: seriesHtml } = await axiosClient.get(nizuSeries, {
      headers: { Referer: seriesUrl }
    });

    const $$ = cheerio.load(seriesHtml);

    // Extract all episode links
    const episodeLinks = $$("a[href*='virak-nearei-hang-pleung-']")
      .map((_, el) => $$(el).attr("href"))
      .get()
      .filter(Boolean);

    const unique = [...new Set(episodeLinks)];

    return unique.map((url, idx) => ({
      id: `${prefix}:${encodeURIComponent(url)}:1:${idx + 1}`,
      title: `Episode ${idx + 1}`,
      season: 1,
      episode: idx + 1,
      thumbnail: "",
      released: new Date().toISOString()
    }));
  } catch (err) {
    console.error("External episode parse error:", err.message);
    return [];
  }
}

module.exports = {
  getEpisodes
};