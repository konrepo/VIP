const cheerio = require("cheerio");
const axiosClient = require("../utils/fetch");
const { normalizePoster, extractVideoLinks, extractMaxEpFromTitle, extractOkIds, uniqById } = require("../utils/helpers");
const { URL_TO_POSTID, POST_INFO, BLOG_IDS } = require("../utils/cache");

const FILE_REGEX =
  /file\s*:\s*["'](https?:\/\/[^"']+\.mp4(?:\?[^"']+)?)["']/gi;

const PLAYLIST_ITEM_REGEX =
  /title\s*:\s*["']([^"']+)["'][\s\S]*?file\s*:\s*["'](https?:\/\/[^"']+)["']/gi;

/* =========================
   HELPERS
========================= */
function extractEpisodeNumber(text) {
  if (!text) return null;

  const cleaned = String(text).trim();

  let match =
    cleaned.match(/\bep(?:isode)?[\s._:-]*(\d{1,4})\b/i) ||
    cleaned.match(/\[(\d{1,4})\]/) ||
    cleaned.match(/\b(\d{1,4})\b/);

  return match ? parseInt(match[1], 10) : null;
}

function extractSundayPlaylist(content) {
  const items = [];
  let match;

  PLAYLIST_ITEM_REGEX.lastIndex = 0;

  while ((match = PLAYLIST_ITEM_REGEX.exec(content)) !== null) {
    const title = (match[1] || "").trim();
    const url = (match[2] || "").trim();

    if (!url) continue;

    items.push({
      title,
      url,
      ep: extractEpisodeNumber(title)
    });
  }

  return items;
}

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter(item => {
    if (!item?.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function sortEpisodes(items) {
  return [...items].sort((a, b) => {
    const epA = Number.isInteger(a.ep) ? a.ep : Number.MAX_SAFE_INTEGER;
    const epB = Number.isInteger(b.ep) ? b.ep : Number.MAX_SAFE_INTEGER;

    if (epA !== epB) {
      return epA - epB;
    }

    return 0;
  });
}

/* =========================
   GET POST ID
========================= */
async function getPostId(url) {
  if (URL_TO_POSTID.has(url)) {
	  return URL_TO_POSTID.get(url);
  }

  const { data } = await axiosClient.get(url);
  const $ = cheerio.load(data);

  // VIP / iDrama
  let postId = $("#player").attr("data-post-id");

  // SundayDrama
  if (!postId) {
    const fanta = $('div[id="fanta"][data-post-id]').first();
    if (fanta.length) {
      postId = fanta.attr("data-post-id");
    }
  }
  
  // SundayDrama fallback
  if (!postId) {
    const match = data.match(
      /blogger\.com\/feeds\/\d+\/posts\/default\/(\d+)\?alt=json/i
    );
    if (match) {
      postId = match[1];
    }
  }

  if (!postId) return null;
  
  // Extract max EP from title OR from SundayDrama "episode/END.xx"
  const pageTitle = $("title").text();
  let maxEp = extractMaxEpFromTitle(pageTitle);
  
  console.log("TITLE DEBUG:", {
    url,
    pageTitle,
    maxEp
  });

  // SundayDrama often has: <b>episode/END.70</b>
  if (!maxEp) {
    const epText =
      $('b:contains("episode/")').first().text() || "";

    const m = epText.match(/episode\/(?:END\.)?(\d+)/i);
    if (m) maxEp = parseInt(m[1], 10);
  }

  URL_TO_POSTID.set(url, postId);

  if (maxEp) {
    POST_INFO.set(postId, {
      ...(POST_INFO.get(postId) || {}),
      maxEp,
    });
  }

  return postId;
}

/* =========================
   BLOGGER FETCH
========================= */
async function fetchFromBlog(blogId, postId) {
  const feedUrl = `https://www.blogger.com/feeds/${blogId}/posts/default/${postId}?alt=json`;

  try {
    const { data } = await axiosClient.get(feedUrl);

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

    let urls = extractVideoLinks(content);

    // If blogger post stores OK.ru IDs (like: 9488...; 9488...; {embed=ok})
    if (!urls.length) {
      const hasOkEmbed = /\{embed\s*=\s*ok\}/i.test(content);
      const okIds = extractOkIds(content);

      if (hasOkEmbed && okIds.length) {
		urls = okIds.map(id => `https://ok.ru/videoembed/${id}`);
      }
    }

    const playlistItems = extractSundayPlaylist(content);

    if (!urls.length && !playlistItems.length) return null;

    return {
      title,
      thumbnail,
      urls,
      playlistItems
    };
  } catch {
    return null;
  }
}

/* =========================
   STREAM DETAIL
========================= */
async function getStreamDetail(postId) {
  const cached = POST_INFO.get(postId);
  if (cached?.detail) return cached.detail;

  const results = await Promise.all(
    Object.values(BLOG_IDS).map(blogId =>
      fetchFromBlog(blogId, postId)
    )
  );

  const detail = results.find(Boolean);
  if (!detail) {
    return null;
  }

  POST_INFO.set(postId, { ...(POST_INFO.get(postId) || {}), detail });

  return detail;
}

/* =========================
   EPISODES
========================= */
async function getEpisodes(prefix, seriesUrl) {
  const postId = await getPostId(seriesUrl);

  // =========================
  // SundayDrama playlist
  // =========================
  if (!postId && prefix === "sunday") {
    const { data } = await axiosClient.get(seriesUrl);

    let playlistItems = extractSundayPlaylist(data);

    if (playlistItems.length) {
      playlistItems = sortEpisodes(
        dedupeByUrl(playlistItems)
      );
    } else {
      FILE_REGEX.lastIndex = 0;

      const urls = [];
      let match;

      while ((match = FILE_REGEX.exec(data)) !== null) {
        urls.push(match[1]);
      }

      playlistItems = dedupeByUrl(
        urls.map((url, index) => ({
          url,
          ep: index + 1,
          title: `Episode ${index + 1}`
        }))
      );
    }

    if (!playlistItems.length) return [];

    const $ = cheerio.load(data);
    const pagePoster =
      $("meta[property='og:image']").attr("content") ||
      $("link[rel='image_src']").attr("href") ||
      "";

    const normalizedPoster = normalizePoster(pagePoster || "");

    return playlistItems.map((item, index) => {
      const epNum = item.ep || index + 1;

      return {
        id: epNum,
        url: item.url,
        title: item.title || `Episode ${epNum}`,
        season: 1,
        episode: epNum,
        thumbnail: normalizedPoster,
        released: new Date().toISOString(),
        behaviorHints: {
          group: `${prefix}:${encodeURIComponent(seriesUrl)}`
        }
      };
    });
  }

  // =========================
  // No postId
  // =========================
  if (!postId) return [];

  const detail = await getStreamDetail(postId);
  if (!detail) return [];

  // =========================
  // Get max episode
  // =========================
  let maxEp = POST_INFO.get(postId)?.maxEp || null;

  console.log("MAX EP DEBUG:", {
    postId,
    stored: POST_INFO.get(postId),
    maxEp
  });

  // fallback from title
  if (!maxEp && detail?.title) {
    const extracted = extractMaxEpFromTitle(detail.title);
    if (extracted) {
      maxEp = extracted;

      POST_INFO.set(postId, {
        ...(POST_INFO.get(postId) || {}),
        maxEp
      });
    }
  }

  // =========================
  // VIP / iDrama / Sunday-like playlist posts
  // =========================
  let episodes = [];

  if (detail.playlistItems && detail.playlistItems.length) {
    episodes = sortEpisodes(
      dedupeByUrl(detail.playlistItems)
    ).map((item, index) => ({
      url: item.url,
      ep: item.ep || index + 1,
      title: item.title || detail.title
    }));

    if (maxEp && episodes.length > maxEp) {
      episodes.splice(maxEp);
    }
  }

  // =========================
  // VIP / iDrama (dedupe)
  // =========================
  else if (prefix === "vip" || prefix === "idrama") {
    const seen = new Set();

    for (let i = 0; i < detail.urls.length; i++) {
      const url = detail.urls[i];

      const m = url.match(/-(\d+)(?:\D|$)/);
      let ep = m ? parseInt(m[1], 10) : null;

      // fallback if no episode number
      if (!ep) {
        ep = i + 1;
      }

      if (!seen.has(ep)) {
        seen.add(ep);

        episodes.push({
          url,
          ep
        });
      }
    }

    // sort properly
    episodes.sort((a, b) => a.ep - b.ep);

    // apply maxEp limit
    if (maxEp && episodes.length > maxEp) {
      episodes.splice(maxEp);
    }
  }

  // =========================
  // KhmerAve / others
  // =========================
  else {
    const urls = [...new Set(detail.urls)];

    episodes = urls.map((url, index) => ({
      url,
      ep: index + 1
    }));
  }

  console.log("FINAL MAX EP:", maxEp);
  console.log("FINAL EP COUNT:", episodes.length);

  return episodes.map(({ url, ep, title }) => ({
    id: ep,
    url,
    title: title || detail.title,
    season: 1,
    episode: ep,
    thumbnail: detail.thumbnail,
    released: new Date().toISOString(),
    behaviorHints: {
      group: `${prefix}:${encodeURIComponent(seriesUrl)}`
    }
  }));
}

/* =========================
   PLAYER RESOLVE
========================= */
async function resolvePlayerUrl(playerUrl) {
  try {
    const { data } = await axiosClient.get(playerUrl);

    const html = data
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&");

    const match = html.match(
      /https?:\/\/phumikhmer\.vip\/player\.php\?stream=[^"'<> ]+/i
    );

    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/* =========================
   RESOLVE OK
========================= */
async function resolveOkEmbed(embedUrl) {
  const { data } = await axiosClient.get(embedUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://ok.ru/"
    }
  });

  // Try both escaped and non-escaped &quot; variants
  const hlsMatch =
    data.match(/\\&quot;ondemandHls\\&quot;:\\&quot;(https:\/\/[^"]+?\.m3u8)/) ||
    data.match(/&quot;ondemandHls&quot;:&quot;(https:\/\/[^"]+?\.m3u8)/);

  if (!hlsMatch) {
    return null;
  }

  return hlsMatch[1]
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/\\&quot;.*/g, "");
}

function buildStream(url, episode) {
  const isOk = /ok\.ru|okcdn\.ru/i.test(url);
  const isM3U8 = url.includes(".m3u8");

  let headers = null;

  if (isOk) {
    headers = {
      Referer: "https://ok.ru/",
      Origin: "https://ok.ru"
    };
  } else if (url.includes("sooplive.co.kr")) {
    headers = {
      Referer: "https://www.sundaydrama.com/",
      Origin: "https://www.sundaydrama.com"
    };
  }

  return {
    url,
    // name: "KhmerDub",
    title: `Episode ${episode}`,
    type: isM3U8 ? "hls" : undefined,
    behaviorHints: {
      group: "khmerdub",
      ...(headers && {
        proxyHeaders: {
          request: headers
        }
      })
    }
  };
}

/* =========================
   STREAM
========================= */
async function getStream(prefix, episodeUrl, episode) {

  // Sunday URL
  if (prefix === "sunday") {
    const stream = buildStream(episodeUrl, episode);
    return stream;
  }

  // Other sites
  let url = episodeUrl;

  // Resolve player.php
  if (url.includes("player.php")) {
    const resolved = await resolvePlayerUrl(url);
    if (!resolved) return null;
    url = resolved;
  }

  // Resolve OK embed
  if (url.includes("ok.ru/videoembed/")) {
    const resolved = await resolveOkEmbed(url);
    if (!resolved) return null;
    url = resolved;
  }

  const stream = buildStream(url, episode);
  return stream;
}

/* =========================
   CATALOG
========================= */
async function getCatalogItems(prefix, siteConfig, url) {
  try {

    // === Sunday Blogger Pagination Support ===
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
            id: link,
            name: title,
            poster: normalizedPoster,
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

      const title = a.text().trim();
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
        id: link,
        name: title,
        poster: normalizedPoster,
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
  getStream,
};