const axiosClient = require("../../utils/fetch");

const {
  resolvePlayerUrl,
  resolveOkEmbed,
  buildStream
} = require("../../utils/streamResolvers");

const { extractVideoLinks } = require("../../utils/helpers");
const { sortStreams } = require("../../utils/streamSort");

const { resolvePost } = require("./postResolver");
const { getStreamDetail } = require("./episodeService");
const wordpressEngine = require("./wordpressEngine");
const { POST_INFO } = require("../../utils/cache");

/* =========================
   PROVIDER NAMES
========================= */
const PROVIDERS = {
  vip: "PhumiVIP",
  sunday: "SundayDrama",
  idrama: "iDramaHD",
  khmerave: "KhmerAve",
  merlkon: "Merlkon",
  phumi2: "PhumiClub"
};

/* =========================
   STREAM
========================= */
async function getStream(prefix, seriesUrl, episode) {
  try {
    console.log("[streamService]", {
      prefix,
      seriesUrl,
      episode
    });

    const providerName = PROVIDERS[prefix] || "KhmerDub";
    const groupName = prefix || "khmerdub";

    /* =========================
       RESOLVE POST
    ========================= */
    const { postId, info } = await resolvePost(seriesUrl);

    /* =========================
       SUNDAY DIRECT FALLBACK
    ========================= */
    if (!postId && prefix === "sunday") {
      const { data } = await axiosClient.get(seriesUrl, {
        headers: { Referer: seriesUrl }
      });

      const links = extractVideoLinks(data);
      const url = links[episode - 1];
      if (!url) return { streams: [] };

      return {
        streams: sortStreams([
          buildStream(url, episode, null, providerName, groupName, seriesUrl)
        ])
      };
    }

    if (!postId || !info) return { streams: [] };

    /* =========================
       FETCH STREAM DETAIL 
    ========================= */
    const detail = await getStreamDetail(postId, info.sourceType, seriesUrl);

    /* ==================================================
       VIP MULTI‑EP EXTERNAL FALLBACK
    =================================================== */
    if (
      prefix === "vip" &&
      detail?.urls?.length === 1 &&
      episode > 1
    ) {
      const cached = POST_INFO.get(postId);
      const slug = cached?.slug;
      if (!slug) return { streams: [] };

      const externalEpisodeUrl =
        `https://nizu.top/${slug}-${episode}/`;

      // bypass getStreamDetail
      const extDetail =
        await wordpressEngine.fetchWordpressDetail(externalEpisodeUrl, null);

      if (!extDetail?.urls?.length) return { streams: [] };

      return {
        streams: sortStreams(
          extDetail.urls.map(url =>
            buildStream(
              url,
              episode,
              null,
              providerName,
              groupName,
              externalEpisodeUrl
            )
          )
        )
      };
    }

    /* =========================
       NORMAL PER‑EP STREAM
    ========================= */
    if (!detail?.urls?.length) return { streams: [] };

    let url = detail.urls[episode - 1];
    if (!url) return { streams: [] };

    if (url.includes("player.php")) {
      url = await resolvePlayerUrl(url);
      if (!url) return { streams: [] };
    }

    if (url.includes("ok.ru/videoembed")) {
      url = await resolveOkEmbed(url);
      if (!url) return { streams: [] };
    }

    return {
      streams: sortStreams([
        buildStream(url, episode, null, providerName, groupName, seriesUrl)
      ])
    };

  } catch (err) {
    console.error("[streamService]", err);
    return { streams: [] };
  }
}

module.exports = {
  getStream
};