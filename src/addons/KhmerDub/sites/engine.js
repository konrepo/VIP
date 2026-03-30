const cheerio = require("cheerio");
const axiosClient = require("../utils/fetch");
const { URL_TO_POSTID, POST_INFO, BLOG_IDS } = require("../utils/cache");
const {
  normalizePoster,
  extractVideoLinks,
  extractMaxEpFromTitle,
  extractOkIds,
  uniqById
} = require("../utils/helpers");

const FILE_REGEX =
  /file\s*:\s*["'](https?:\/\/[^"']+\.mp4(?:\?[^"']+)?)["']/gi;

const {
  resolvePlayerUrl,
  resolveOkEmbed,
  buildStream
} = require("../utils/streamResolvers");

/* =========================
   VIP / IDRAMA BLOGGER CONTENT
========================= */
function parseVipBloggerContent(content = "") {
  const urls = [];
  const okIds = [];

  urls.push(...extractVideoLinks(content));

  let m;

  const dmRegex = /\{dm=(\w+)\}/gi;
  while ((m = dmRegex.exec(content)) !== null) {
    urls.push(`https://www.dailymotion.com/embed/video/${m[1]}`);
  }

  const gdRegex = /\{gd=(\w+)\}/gi;
  while ((m = gdRegex.exec(content)) !== null) {
    urls.push(`https://drive.google.com/file/d/${m[1]}/preview`);
  }

  const okRegex = /\{ok=(\w+)\}/gi;
  while ((m = okRegex.exec(content)) !== null) {
    okIds.push(m[1]);
  }

  if (/\{embed\s*=\s*ok\}/i.test(content)) {
    okIds.forEach((id) => {
      urls.push(`https://ok.ru/videoembed/${id}`);
    });
  }

  const parts = content
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    if (/^https?:\/\//i.test(part)) {
      urls.push(part);
      continue;
    }

    const dm = part.match(/\{dm=(\w+)\}/i);
    if (dm) {
      urls.push(`https://www.dailymotion.com/embed/video/${dm[1]}`);
      continue;
    }

    const gd = part.match(/\{gd=(\w+)\}/i);
    if (gd) {
      urls.push(`https://drive.google.com/file/d/${gd[1]}/preview`);
      continue;
    }

    const ok = part.match(/\{ok=(\w+)\}/i);
    if (ok) {
      urls.push(`https://ok.ru/videoembed/${ok[1]}`);
    }
  }

  return [...new Set(urls)];
}

/* =========================
   GET POST ID
========================= */
async function getPostId(url) {
  if (URL_TO_POSTID.has(url)) {
    return URL_TO_POSTID.get(url);
  }

  const { data } = await axiosClient.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: url
    }
  });

  const $ = cheerio.load(data);

  let postId = null;
  let sourceType = null;
  let playerPostId = null;
  let wpPostId = null;

  // 1) Prefer player[data-post-id] first
  playerPostId = $("#player").attr("data-post-id") || null;

  if (!playerPostId) {
    const fanta = $('div[id="fanta"][data-post-id]').first();
    if (fanta.length) {
      playerPostId = fanta.attr("data-post-id");
    }
  }

  if (!playerPostId) {
    const match = data.match(
      /blogger\.com\/feeds\/\d+\/posts\/default\/(\d+)\?alt=json/i
    );
    if (match) {
      playerPostId = match[1];
    }
  }

  // 2) WordPress post id fallback / metadata
  let m = null;

  const shortlink = $('link[rel="shortlink"]').attr("href") || "";
  m = shortlink.match(/[?&]p=(\d+)/i);

  if (!m) {
    const apiLink =
      $('link[rel="alternate"][type="application/json"]').attr("href") || "";
    m = apiLink.match(/\/wp-json\/wp\/v2\/posts\/(\d+)/i);
  }

  if (!m) {
    const articleId = $("article[id^='post-']").attr("id") || "";
    m = articleId.match(/^post-(\d+)$/i);
  }

  if (!m) {
    const imgPostId = $("img[post-id]").first().attr("post-id");
    if (imgPostId) {
      m = [, imgPostId];
    }
  }

  if (m) {
    wpPostId = m[1];
  }

  // 3) Decide main postId + sourceType
  if (playerPostId) {
    postId = playerPostId;

    if (wpPostId) {
      sourceType = "wp-blogger";
    } else {
      sourceType = "blogger";
    }
  } else if (wpPostId) {
    postId = wpPostId;
    sourceType = "vip-wordpress";
  }

  if (!postId) return null;

  const pageTitle = $("title").text().trim();
  let maxEp = extractMaxEpFromTitle(pageTitle);

  if (!maxEp) {
    const epText = $('b:contains("episode/")').first().text() || "";
    const epMatch = epText.match(/episode\/(?:END\.)?(\d+)/i);
    if (epMatch) maxEp = parseInt(epMatch[1], 10);
  }

  URL_TO_POSTID.set(url, postId);

  POST_INFO.set(postId, {
    ...(POST_INFO.get(postId) || {}),
    maxEp: maxEp || null,
    sourceType: sourceType || "unknown",
    pageHtml: data,
    playerPostId: playerPostId || null,
    wpPostId: wpPostId || null
  });

  console.log("[POSTID]", {
    url,
    postId,
    sourceType,
    maxEp,
    playerPostId,
    wpPostId
  });

  return postId;
}

/* =========================
   BLOGGER FETCH JSON
========================= */
async function fetchBloggerJson(blogId, postId) {
  const feedUrl = `https://www.blogger.com/feeds/${blogId}/posts/default/${postId}?alt=json`;

  try {
    const { data } = await axiosClient.get(feedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    return data?.entry || null;
  } catch {
    return null;
  }
}

/* =========================
   BLOGGER FETCH
========================= */
async function fetchFromBlog(blogId, postId) {
  const feedUrl = `https://www.blogger.com/feeds/${blogId}/posts/default/${postId}?alt=json`;

  try {
    const { data } = await axiosClient.get(feedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const title = data.entry.title.$t;
    const content = data.entry.content?.$t || "";
    const $content = cheerio.load(content);

    let thumbnail =
      $content('meta[property="og:image"]').attr("content") ||
      $content('meta[name="twitter:image"]').attr("content") ||
      $content("img").first().attr("src") ||
      data.entry.media$thumbnail?.url ||
      "";

    thumbnail = normalizePoster(thumbnail);

    let urls = parseVipBloggerContent(content);

    if (!urls.length) {
      let okUrls = [];
      const hasOkEmbed = /\{embed\s*=\s*ok\}/i.test(content);
      const okIds = extractOkIds(content);

      if (hasOkEmbed && okIds.length) {
        okUrls = okIds.map((id) => `https://ok.ru/videoembed/${id}`);
      }

      urls = okUrls;
    }

    if (!urls.length) return null;

    return {
      title,
      thumbnail,
      urls: [...new Set(urls)]
    };
  } catch {
    return null;
  }
}

/* =========================
   WORDPRESS / HYBRID FETCH
========================= */
async function fetchWpHybridDetail(seriesUrl, postId) {
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
    $("h1.entry-title").first().text().trim() ||
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

  // 1) Try direct HTML first
  let urls = extractVideoLinks(pageHtml);
  console.log("[WP-HYBRID] pageHtml direct urls:", urls);

  if (!urls.length) {
    const scripts = $("script")
      .map((_, el) => $(el).html() || "")
      .get()
      .join("\n");

    urls = extractVideoLinks(scripts);
    console.log("[WP-HYBRID] inline script urls:", urls);
  }

  if (urls.length) {
    return {
      title: pageTitle,
      thumbnail,
      urls: [...new Set(urls)]
    };
  }

  // 2) Try wp-json post rendered content if wpPostId exists
  if (cached.wpPostId) {
    try {
      const apiBase = new URL(seriesUrl).origin;
      const wpApiUrl = `${apiBase}/wp-json/wp/v2/posts/${cached.wpPostId}`;
      const { data: wpPost } = await axiosClient.get(wpApiUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: seriesUrl
        }
      });

      const rendered = wpPost?.content?.rendered || "";
      const restUrls = extractVideoLinks(rendered);
      console.log("[WP-HYBRID] wp-json rendered urls:", restUrls);

      if (restUrls.length) {
        return {
          title: wpPost?.title?.rendered || pageTitle,
          thumbnail,
          urls: [...new Set(restUrls)]
        };
      }
    } catch {
      console.log("[WP-HYBRID] wp-json post fetch failed");
    }
  }

  return {
    title: pageTitle,
    thumbnail,
    urls: []
  };
}

/* =========================
   STREAM DETAIL
========================= */
async function getStreamDetail(postId, seriesUrl) {
  const cached = POST_INFO.get(postId);
  if (cached?.detail) return cached.detail;

  const sourceType = cached?.sourceType || "blogger";
  let detail = null;

  // Blogger-backed first for blogger / wp-blogger pages
  if (sourceType === "blogger" || sourceType === "wp-blogger") {
    const results = await Promise.all(
      Object.values(BLOG_IDS).map((blogId) => fetchFromBlog(blogId, postId))
    );

    detail = results.find(Boolean);

    // If blogger result found, enrich poster from wp page if missing/bad
    if (detail && sourceType === "wp-blogger") {
      const wpDetail = await fetchWpHybridDetail(seriesUrl, postId);
      if (wpDetail?.thumbnail) {
        detail.thumbnail = wpDetail.thumbnail;
      }
      if ((!detail.title || !detail.title.trim()) && wpDetail?.title) {
        detail.title = wpDetail.title;
      }
    }

    // If blogger fetch failed, try direct wp/html fallback
    if (!detail && sourceType === "wp-blogger") {
      const wpDetail = await fetchWpHybridDetail(seriesUrl, postId);
      if (wpDetail?.urls?.length) {
        detail = wpDetail;
      }
    }
  } else if (sourceType === "vip-wordpress") {
    const wpDetail = await fetchWpHybridDetail(seriesUrl, postId);
    if (wpDetail?.urls?.length) {
      detail = wpDetail;
    }
  }

  if (!detail) {
    return null;
  }

  POST_INFO.set(postId, {
    ...(POST_INFO.get(postId) || {}),
    detail
  });

  return detail;
}

/* =========================
   EPISODES
========================= */
async function getEpisodes(prefix, seriesUrl) {
  const postId = await getPostId(seriesUrl);

  // Sunday playlist
  if (!postId && prefix === "sunday") {
    const { data } = await axiosClient.get(seriesUrl);

    FILE_REGEX.lastIndex = 0;

    const urls = [];
    let match;

    while ((match = FILE_REGEX.exec(data)) !== null) {
      urls.push(match[1]);
    }

    const $ = cheerio.load(data);
    const pagePoster =
      $("meta[property='og:image']").attr("content") ||
      $("link[rel='image_src']").attr("href") ||
      "";

    const normalizedPoster = normalizePoster(pagePoster);

    return urls.map((url, index) => ({
      id: `${prefix}:${encodeURIComponent(seriesUrl)}:1:${index + 1}`,
      title: `Episode ${index + 1}`,
      season: 1,
      episode: index + 1,
      thumbnail: normalizedPoster,
      released: new Date().toISOString()
    }));
  }

  if (!postId) {
    return [];
  }

  const detail = await getStreamDetail(postId, seriesUrl);

  console.log("[EPISODES]", {
    prefix,
    seriesUrl,
    postId,
    detail
  });

  if (!detail) {
    if (prefix === "vip" || prefix === "idrama") {
      try {
        const { data } = await axiosClient.get(seriesUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0",
            Referer: seriesUrl
          }
        });

        const fallbackUrls = extractVideoLinks(data);
        console.log(`[${prefix.toUpperCase()}] fallback episode urls:`, fallbackUrls);

        if (fallbackUrls.length) {
          const $ = cheerio.load(data);
          const poster =
            $("meta[property='og:image']").attr("content") ||
            $("meta[name='twitter:image']").attr("content") ||
            $("img[post-id]").first().attr("src") ||
            "";

          return fallbackUrls.map((url, index) => ({
            id: `${prefix}:${encodeURIComponent(seriesUrl)}:1:${index + 1}`,
            title: `Episode ${index + 1}`,
            season: 1,
            episode: index + 1,
            thumbnail: normalizePoster(poster),
            released: new Date().toISOString()
          }));
        }
      } catch (err) {
        console.log(`[${prefix.toUpperCase()}] fallback error:`, err.message);
      }
    }

    return [];
  }

  const maxEp = POST_INFO.get(postId)?.maxEp || null;

  let urls = [...new Set(detail.urls)];

  if (maxEp && urls.length > maxEp) {
    urls = urls.slice(0, maxEp);
  }

  return urls.map((url, index) => ({
    id: `${prefix}:${encodeURIComponent(seriesUrl)}:1:${index + 1}`,
    title: `Episode ${index + 1}`,
    season: 1,
    episode: index + 1,
    thumbnail: detail.thumbnail,
    released: new Date().toISOString()
  }));
}

/* =========================
   STREAM
========================= */
async function getStream(prefix, seriesUrl, episode) {
  const postId = await getPostId(seriesUrl);

  const providerNames = {
    vip: "PhumiVIP",
    sunday: "SundayDrama",
    idrama: "iDramaHD",
    khmerave: "KhmerAve",
    merlkon: "Merlkon",
    phumi2: "PhumiClub"
  };

  const providerName = providerNames[prefix] || "KhmerDub";
  const groupName = prefix || "khmerdub";

  // Sunday fallback streaming
  if (prefix === "sunday" && !postId) {
    const { data } = await axiosClient.get(seriesUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: seriesUrl
      }
    });

    const links = extractVideoLinks(data);
    const url = links[episode - 1];
    if (!url) return null;

    return buildStream(url, episode, undefined, providerName, groupName);
  }

  if (!postId) return null;

  const detail = await getStreamDetail(postId, seriesUrl);
  if (!detail) return null;

  let url = detail.urls[episode - 1];
  if (!url) return null;

  if (url.includes("player.php")) {
    const resolved = await resolvePlayerUrl(url);
    if (!resolved) return null;
    url = resolved;
  }

  if (url.includes("ok.ru/videoembed/")) {
    const resolved = await resolveOkEmbed(url);
    if (!resolved) return null;
    url = resolved;
  }

  return buildStream(url, episode, undefined, providerName, groupName);
}

/* =========================
   CATALOG
========================= */
async function getCatalogItems(prefix, siteConfig, url) {
  try {
    if (prefix === "sunday") {
      const allItems = [];
      let currentUrl = url;
      const BLOGGER_PAGES_PER_BATCH = 3;

      for (let i = 0; i < BLOGGER_PAGES_PER_BATCH && currentUrl; i++) {
        const { data: pageData } = await axiosClient.get(currentUrl);
        const $$ = cheerio.load(pageData);

        const articles = $$(siteConfig.articleSelector).toArray();

        for (const el of articles) {
          const $el = $$(el);
          const a = $el.find(siteConfig.titleSelector).first();

          const title =
            a.attr("title")?.trim() ||
            a.text().trim();

          const link = a.attr("href");
          if (!title || !link) continue;

          let poster = "";
          const posterEl = $el.find(siteConfig.posterSelector).first();
          for (const attr of siteConfig.posterAttrs) {
            poster = posterEl.attr(attr) || poster;
            if (poster) break;
          }

          const normalizedPoster = normalizePoster(poster);

          allItems.push({
            id: `${prefix}:${encodeURIComponent(link)}`,
            name: title,
            poster: normalizedPoster
          });
        }

        const older = $$("a.blog-pager-older-link").attr("href");
        currentUrl = older || null;
      }

      return uniqById(allItems);
    }

    const { data } = await axiosClient.get(url);
    const $ = cheerio.load(data);

    const articles = $(siteConfig.articleSelector).toArray();

    const results = articles.map((el) => {
      const $el = $(el);
      const a = $el.find(siteConfig.titleSelector).first();

      const title =
        a.attr("title")?.trim() ||
        a.text().trim();

      const link = a.attr("href");
      if (!title || !link) return null;

      let poster = "";
      const posterEl = $el.find(siteConfig.posterSelector).first();
      for (const attr of siteConfig.posterAttrs) {
        poster = posterEl.attr(attr) || poster;
        if (poster) break;
      }

      const normalizedPoster = normalizePoster(poster);

      return {
        id: `${prefix}:${encodeURIComponent(link)}`,
        name: title,
        poster: normalizedPoster
      };
    });

    return results.filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  getCatalogItems,
  getEpisodes,
  getStream
};
