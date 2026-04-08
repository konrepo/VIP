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

    const links = $("a[href]")
      .map((_, el) => $(el).attr("href"))
      .get()
      .filter(h =>
        h &&
        /^https?:\/\/[^/]+\/[^/]+-\d+$/i.test(h)
      );

    if (!links.length) return [];

    const unique = [...new Set(links)];

    return unique.map((_, idx) => ({
      id: `${prefix}:${encodeURIComponent(seriesUrl)}:1:${idx + 1}`,
      title: `Episode ${idx + 1}`,
      season: 1,
      episode: idx + 1,
      thumbnail: "",
      released: new Date().toISOString()
    }));
  } catch {
    return [];
  }
}

module.exports = {
  getEpisodes
};