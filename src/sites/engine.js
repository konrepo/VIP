const cheerio = require("cheerio");
const axiosClient = require("../utils/fetch");
const { normalizePoster, extractVideoLinks, extractMaxEpFromTitle, extractOkIds } = require("../utils/helpers");
const { URL_TO_POSTID, POST_INFO, BLOG_IDS } = require("../utils/cache");

/* =========================
   GET POST ID
========================= */
async function getPostId(url) {
  if (URL_TO_POSTID.has(url)) return URL_TO_POSTID.get(url);

  const { data } = await axiosClient.get(url);
  const $ = cheerio.load(data);

  // VIP / iDrama
  let postId = $("div#player").attr("data-post-id");

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

    if (!urls.length) return null;

    return { title, thumbnail, urls };
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

  for (const blogId of Object.values(BLOG_IDS)) {
    const detail = await fetchFromBlog(blogId, postId);
    if (detail) {
      POST_INFO.set(postId, { ...(POST_INFO.get(postId) || {}), detail });
      return detail;
    }
  }

  return null;
}

/* =========================
   EPISODES
========================= */
async function getEpisodes(prefix, seriesUrl) {

  // prevent homepage being treated as a series
  if (seriesUrl === "https://phumikhmer.vip/" || seriesUrl.endsWith(".vip/")) {
    console.log("INVALID SERIES URL:", seriesUrl);
    return [];
  }

  const postId = await getPostId(seriesUrl);
  console.log("POST ID:", postId);

  // Sunday playlist
  if (!postId && prefix === "sunday") {
    const { data } = await axiosClient.get(seriesUrl);

    const $ = cheerio.load(data);
    const pagePoster =
      $("meta[property='og:image']").attr("content") ||
      $("link[rel='image_src']").attr("href") ||
      "";

    const fileRegex =
      /file\s*:\s*["'](https?:\/\/[^"']+\.mp4(?:\?[^"']+)?)["']/gi;

    const urls = [];
    let match;
    while ((match = fileRegex.exec(data)) !== null) {
      urls.push(match[1]);
    }

    return urls.map((url, index) => {
      const encoded = Buffer.from(seriesUrl).toString("base64");

      return {
        id: `${prefix}:${encodeURIComponent(seriesUrl)}:${index + 1}`,
        title: `Episode ${index + 1}`,
        season: 1,
        episode: index + 1,
        thumbnail: normalizePoster(pagePoster),
        released: new Date().toISOString()
      };
    });
  }

  if (!postId) {
    return [];
  }

  const detail = await getStreamDetail(postId);

  if (!detail) {
    return [];
  }

  const maxEp = POST_INFO.get(postId)?.maxEp || null;

  const seen = new Set();
  let urls = [];

  for (const u of detail.urls) {
    if (!seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  }

  if (maxEp && urls.length > maxEp) {
    urls = urls.slice(0, maxEp);
  }
  console.log("EPISODES GENERATED:", urls.length);

  return urls.map((url, index) => {
    const encoded = Buffer.from(seriesUrl).toString("base64");

    return {
      id: `${prefix}:${encodeURIComponent(seriesUrl)}:${index + 1}`,
      title: detail.title,
      season: 1,
      episode: index + 1,
      thumbnail: detail.thumbnail,
      released: new Date().toISOString()
    };
  });
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
    console.log("OK: ondemandHls not found");
    return null;
  }

  return hlsMatch[1]
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/\\&quot;.*/g, ""); // safety: cut anything after if it appears
}

/* =========================
   STREAM
========================= */
async function getStream(prefix, seriesUrl, episode) {
  const postId = await getPostId(seriesUrl);
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

    const isOk = /ok\.ru|okcdn\.ru/i.test(url);

    return {
      url,
      name: "KhmerDub",
      title: `Episode ${episode}`,
      type: url.includes(".m3u8") ? "hls" : undefined,
      behaviorHints: isOk 
		? {
			group: "khmerdub",
			proxyHeaders: {
			  request: {
				Referer: "https://ok.ru/",
				Origin: "https://ok.ru",
			  },
			},
		}
      : { group: "khmerdub" },
    };
  }

  if (!postId) return null;

  const detail = await getStreamDetail(postId);
  if (!detail) {
	  console.log("No detail found for postId:", postId);
	  return null;
  }
  
  console.log("DETAIL URLS:", detail.urls);

  let url = detail.urls[episode - 1];
  if (!url) {
	  console.log("No URL for episode:", episode);
	  return null;
  }

  // Resolve player.php first
  if (url.includes("player.php")) {
	  const resolved = await resolvePlayerUrl(url);
	  if (!resolved) {
		  console.log("Player resolve failed");
		  return null;
	  }
	  url = resolved;
  }

  // Resolve OK embed page
  if (url.includes("ok.ru/videoembed/")) {
	  const resolved = await resolveOkEmbed(url);
	  if (!resolved) {
		  console.log("OK embed resolve failed");
		  return null;
	  }
	  url = resolved;
  }

  console.log("Final URL:", url);

  const isOk = /ok\.ru|okcdn\.ru/i.test(url);
  console.log("Is OK stream:", isOk);

  return {
	  url,
	  name: "KhmerDub",
	  title: `Episode ${episode}`,
	  type: url.includes(".m3u8") ? "hls" : undefined,
	  behaviorHints: isOk
		  ? {
			  group: "khmerdub",
			  proxyHeaders: {
				  request: {
					  Referer: "https://ok.ru/",
					  Origin: "https://ok.ru"
				  }
			  }
		  }
		  : { group: "khmerdub" }
  };
}

/* =========================
   CATALOG
========================= */
async function getCatalogItems(prefix, siteConfig, url) {
  try {
  const { data } = await axiosClient.get(url);
  
  const $ = cheerio.load(data);
  
  // === Sunday Blogger Pagination Support (ADD ONLY) ===
  if (prefix === "sunday") {
    const allItems = [];
    let currentUrl = url;
    const PAGES_PER_BATCH = 3;

    for (let i = 0; i < PAGES_PER_BATCH && currentUrl; i++) {
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
        if (!title || !link) return null;
		if (link === "/" || link === "#" || link.startsWith("javascript")) return null;

        let poster = "";
        const posterEl = $el.find(siteConfig.posterSelector).first();
        for (const attr of siteConfig.posterAttrs) {
          poster = posterEl.attr(attr) || poster;
          if (poster) break;
        }

        allItems.push({
          id: `${prefix}:${encodeURIComponent(link)}`,
          name: title,
          poster: normalizePoster(poster),
        });
      }

      const older = $$("a.blog-pager-older-link").attr("href");
      currentUrl = older || null;
    }

    return Array.from(
      new Map(allItems.map(x => [x.id, x])).values()
    );
  }

  const articles = $(siteConfig.articleSelector).toArray();

  const results = await Promise.all(
    articles.map(async (el) => {
      const $el = $(el);
      const a = $el.find(siteConfig.titleSelector).first();

      const title = a.text().trim();
      let link = a.attr("href");
	  
      if (!title || !link) return null;

      // convert relative links to absolute
      if (link.startsWith("/")) {
        link = new URL(link, siteConfig.baseUrl).href;
      }

      // filter invalid links
      if (
        link === siteConfig.baseUrl ||
        link === siteConfig.baseUrl + "/" ||
        link === "https://phumikhmer.vip/" ||
        link === "#" ||
        link.startsWith("javascript")
      ) return null;

      let poster = "";
      const posterEl = $el.find(siteConfig.posterSelector).first();
      for (const attr of siteConfig.posterAttrs) {
        poster = posterEl.attr(attr) || poster;
        if (poster) break;
      }

      return {
        id: `${prefix}:${encodeURIComponent(link)}`,
        name: title,
        poster: normalizePoster(poster),
      };
    })
  );

  return results.filter(Boolean);
  
  } catch {;
    return [];
  }  
}

module.exports = {
  getCatalogItems,
  getEpisodes,
  getStream,
};
