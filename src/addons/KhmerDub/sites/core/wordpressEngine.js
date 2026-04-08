const cheerio = require("cheerio");
const axiosClient = require("../../utils/fetch");
const { withRequestCache } = require("../../utils/requestCache");

const bloggerEngine = require("./bloggerEngine");
const { BLOG_IDS } = require("../../utils/cache");

const {
  normalizePoster,
  extractVideoLinks
} = require("../../utils/helpers");

async function fetchWordpressDetail(seriesUrl, postId) {
  const cacheKey = `wp:${postId}`;

  return withRequestCache(cacheKey, async () => {
    try {
      /* =========================
         FETCH WORDPRESS PAGE
      ========================= */
      const { data } = await axiosClient.get(seriesUrl, {
        headers: { Referer: seriesUrl }
      });

      const $ = cheerio.load(data);

      const title =
        $("h1").first().text().trim() ||
        $("meta[property='og:title']").attr("content") ||
        "";

      let thumbnail =
        $("meta[property='og:image']").attr("content") ||
        $("img").first().attr("src") ||
        "";

      thumbnail = normalizePoster(thumbnail);

      /* =========================
         DIRECT PAGE SCAN
      ========================= */
      let urls = extractVideoLinks(data);
      if (urls.length) {
        return { title, thumbnail, urls };
      }

      /* =========================
         INLINE SCRIPT SCAN
      ========================= */
      const scripts = $("script")
        .map((_, el) => $(el).html() || "")
        .get()
        .join("\n");

      urls = extractVideoLinks(scripts);
      if (urls.length) {
        return { title, thumbnail, urls };
      }

      /* =========================
         WP REST API FALLBACK
      ========================= */
      try {
        const apiUrl = `https://phumikhmer.vip/wp-json/wp/v2/posts/${postId}`;
        const { data: wpData } = await axiosClient.get(apiUrl, {
          headers: { Referer: seriesUrl }
        });

        const rendered = wpData?.content?.rendered || "";
        const restUrls = extractVideoLinks(rendered);

        if (restUrls.length) {
          return {
            title: wpData?.title?.rendered || title,
            thumbnail,
            urls: restUrls
          };
        }
      } catch {
        // Ignore REST failures
      }

      /* =========================
         BLOGGER PLAYER FALLBACK 
         <div id="player" data-post-id="XXXXXXXXXXXXX"></div>
      ========================= */
      const bloggerPostId =
        $("#player").attr("data-post-id") ||
        $("div#player[data-post-id]").attr("data-post-id");

      if (bloggerPostId) {
        for (const blogId of Object.values(BLOG_IDS)) {
          const detail = await bloggerEngine.fetchFromBlog(
            blogId,
            bloggerPostId
          );
          if (detail) {
            return detail;
          }
        }
      }

      return null;

    } catch {
      return null;
    }
  });
}

module.exports = {
  fetchWordpressDetail
};