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

    /* ==================================================
       EXTERNAL EPISODE PAGE (VIP only, e.g. nizu.top)
       Triggered only when the ID encodes an episode URL
    =================================================== */
    if (
      prefix === "vip" &&
      /^https?:\/\/[^/]+\/.*-\d+\/?$/.test(seriesUrl)
    ) {
      const detail = await getStreamDetail(null, "wordpress", seriesUrl);
      if (!detail?.urls?.length) {
        return { streams: [] };
      }

      const streams = detail.urls.map(url =>
        buildStream(
          url,
          episode,
          null,
          providerName,
          groupName,
          seriesUrl
        )
      );

      return { streams: sortStreams(streams) };
    }

    /* =========================
       RESOLVE POST (TTL‑AWARE)
    ========================= */
    const { postId, info } = await resolvePost(seriesUrl);

    /* =========================
       SUNDAY DIRECT FALLBACK
    ========================= */
    if (!postId && prefix === "sunday") {
      try {
        const { data } = await axiosClient.get(seriesUrl, {
          headers: { Referer: seriesUrl }
        });

        const links = extractVideoLinks(data);
        const url = links[episode - 1];
        if (!url) return { streams: [] };

        const stream = buildStream(
          url,
          episode,
          null,
          providerName,
          groupName,
          seriesUrl
        );

        return { streams: sortStreams([stream]) };
      } catch {
        return { streams: [] };
      }
    }

    if (!postId || !info) return { streams: [] };

    /* =========================
       FETCH STREAM DETAIL
    ========================= */
    const detail = await getStreamDetail(postId, info.sourceType, seriesUrl);
    if (!detail?.urls?.length) return { streams: [] };

    let url = detail.urls[episode - 1];
    if (!url) return { streams: [] };

    /* =========================
       RESOLVE INDIRECT STREAMS
    ========================= */
    if (url.includes("player.php")) {
      url = await resolvePlayerUrl(url);
      if (!url) return { streams: [] };
    }

    if (url.includes("ok.ru/videoembed")) {
      url = await resolveOkEmbed(url);
      if (!url) return { streams: [] };
    }

    /* =========================
       BUILD & SORT STREAMS
    ========================= */
    const stream = buildStream(
      url,
      episode,
      null,
      providerName,
      groupName,
      seriesUrl
    );

    return {
      streams: sortStreams([stream])
    };

  } catch (err) {
    console.error("[streamService]", err);
    return { streams: [] };
  }
}

module.exports = {
  getStream
};