const TYPE = "series";
const EXTRA = ["search", "skip"];

const sites = [
  { id: "vip", name: "PhumiVip-TEST" },
  { id: "sunday", name: "SundayDrama-TEST" },
  { id: "phumi2", name: "PhumiClub-TEST" },
  { id: "khmerave", name: "KhmerAve-TEST" },
  { id: "merlkon", name: "Merlkon-TEST" },
  { id: "idrama", name: "iDramaHD-TEST" },  
];

module.exports = {
  id: "community.khmer.test",
  version: "3.5.0-test",
  name: "KhmerDub Test",
  description: "Stream Experimental Build STREMIO | Dev: TheDevilz.",
  logo: "https://raw.githubusercontent.com/konrepo/VIP/refs/heads/main/test.png",

  resources: ["catalog", "meta", "stream"],
  types: [TYPE],

  catalogs: sites.map(site => ({
    type: TYPE,
    id: site.id,
    name: site.name,
    extraSupported: EXTRA
  })),

  behaviorHints: {
    configurable: false
  }
  
};
