const TYPES = ["series", "movie"];
const EXTRA = ["search", "skip"];

const sites = [
  { id: "vip", name: "PhumiVip-TEST", type: "series" },
  { id: "sunday", name: "SundayDrama-TEST", type: "series" },
  { id: "phumi2", name: "PhumiClub-TEST", type: "series" },
  { id: "khmerave", name: "KhmerAve-TEST", type: "series" },
  { id: "merlkon", name: "Merlkon-TEST", type: "series" },
  { id: "idrama", name: "iDramaHD-TEST", type: "series" },

  { id: "cat3movie", name: "Cat3Movie-TEST", type: "movie" }
];

module.exports = {
  id: "community.khmer.test",
  version: "3.5.0-test",
  name: "KhmerDub Test",
  description: "Stream Experimental Build STREMIO | Dev: TheDevilz.",
  logo: "https://raw.githubusercontent.com/konrepo/VIP/refs/heads/main/test.png",

  resources: ["catalog", "meta", "stream"],
  types: TYPES,

  catalogs: sites.map(site => ({
    type: site.type,
    id: site.id,
    name: site.name,
    extraSupported: EXTRA
  })),

  behaviorHints: {
    configurable: false
  }
};