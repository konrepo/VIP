const cheerio = require("cheerio");
const axiosClient = require("../../utils/fetch");
const { POST_INFO } = require("../../utils/cache");
const { normalizePoster, extractVideoLinks } = require("../../utils/helpers");
const { findVipBloggerDetailBySearch } = require("./vipSearch");

/* =========================
   FETCH VIP WORDPRESS
========================= */
async function fetchVipWordpressDetail(seriesUrl, postId) {
  const cached = POST_INFO.get(postId) || {};

  let pageHtml = cached.pageHtml;
  if (!pageHtml) {
    const { data } = await axiosClient.get(seriesUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: seriesUrl
      }
    });
    pageHtml = data;
  }

  const $ = cheerio.load(pageHtml);

  const pageTitle =
    $("h1.single-post-title .post-title").text().trim() ||
    $("meta[property='og:title']").attr("content") ||
    $("title").text().trim();

  let thumbnail =
    $("meta[property='og:image']").attr("content") ||
    $("meta[name='twitter:image']").attr("content") ||
    $("img[post-id]").first().attr("src") ||
    $("img[post-id]").first().attr("data-src") ||
    "";

  thumbnail = normalizePoster(thumbnail);

  // 1. direct page scan
  let urls = extractVideoLinks(pageHtml);
  if (urls.length) {
    return {
      title: pageTitle,
      thumbnail,
      urls: [...new Set(urls)]
    };
  }

  // 2. inline scripts scan
  const scripts = $("script")
    .map((_, el) => $(el).html() || "")
    .get()
    .join("\n");

  urls = extractVideoLinks(scripts);
  if (urls.length) {
    return {
      title: pageTitle,
      thumbnail,
      urls: [...new Set(urls)]
    };
  }

  // 3. wp-json post content scan
  try {
    const wpApiUrl = `https://phumikhmer.vip/wp-json/wp/v2/posts/${postId}`;
    const { data: wpPost } = await axiosClient.get(wpApiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: seriesUrl
      }
    });

    const rendered = wpPost?.content?.rendered || "";
    const restUrls = extractVideoLinks(rendered);

    if (restUrls.length) {
      return {
        title: wpPost?.title?.rendered || pageTitle,
        thumbnail,
        urls: [...new Set(restUrls)]
      };
    }
  } catch {}

  // 4. search blogger by slug/title
  const searched = await findVipBloggerDetailBySearch(seriesUrl, postId);
  if (searched) {
    if (!searched.thumbnail && thumbnail) {
      searched.thumbnail = thumbnail;
    }
    return searched;
  }

  return null;
}

module.exports = {
  fetchVipWordpressDetail,
};