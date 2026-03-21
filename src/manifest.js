const TYPE = "series";
const EXTRA = ["search", "skip"];

const sites = [
  { id: "vip", name: "Phumikhmer" },
  { id: "sunday", name: "SundayDrama" },
  { id: "idrama", name: "iDramaHD" },
  { id: "khmerave", name: "KhmerAve" },
  { id: "merlkon", name: "Merlkon" },
];

module.exports = {
  id: "community.khmer.test",
  version: "1.3.0-test",
  name: "KhmerDub Test",
  description: "Stream Experimental Build | Dev: TheDevilz.",
  logo: "https://raw.githubusercontent.com/konrepo/VIP/refs/heads/main/test.png",

  resources: ["catalog", "meta", "stream"],
  types: [TYPE],
  idPrefixes: sites.map(s => s.id),

  catalogs: sites.map((site) => ({
    type: TYPE,
    id: site.id,
    name: site.name,
    extraSupported: EXTRA,
  })),

  behaviorHints: {
    configurable: false,
    adult: false,
  },
};