module.exports = {
  id: "community.khmer.test",
  version: "1.2.0-test",
  name: "KhmerDub Test",
  description: "Stream Experimental Build | Dev: TheDevilz.",
  logo: "https://raw.githubusercontent.com/konrepo/VIP/refs/heads/main/test.png",
  types: ["series"],
  resources: [
    "catalog",
    {
      name: "meta",
      types: ["series"],
      idPrefixes: ["vip", "sunday", "idrama", "khmerave", "merlkon"]
    },
    {
      name: "stream",
      types: ["series"],
      idPrefixes: ["vip", "sunday", "idrama", "khmerave", "merlkon"]
    }
  ],
  catalogs: [
    {
      type: "series",
      id: "vip",
      name: "Phumikhmer (test)",
      extraSupported: ["search", "skip"]
    },
    {
      type: "series",
      id: "sunday",
      name: "SundayDrama (test)",
      extraSupported: ["search", "skip"]
    },
    {
      type: "series",
      id: "idrama",
      name: "iDramaHD (test)",
      extraSupported: ["search", "skip"]
    },
    {
      type: "series",
      id: "khmerave",
      name: "KhmerAve (test)",
      extraSupported: ["search", "skip"]
    },
    {
      type: "series",
      id: "merlkon",
      name: "Merlkon (test)",
      extraSupported: ["search", "skip"]
    }
  ]
};