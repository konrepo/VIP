const TYPE = "series";
const EXTRA = ["search", "skip"];

const sites = [
  { id: "vip", name: "Phumikhmer-test" },
  { id: "sunday", name: "SundayDrama-test" },
  { id: "idrama", name: "iDramaHD-test" },
  { id: "khmerave", name: "KhmerAve-test" },
  { id: "merlkon", name: "Merlkon-test" },
];

module.exports = {
  id: "community.khmer.test",
  version: "3.5.0-test",
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
