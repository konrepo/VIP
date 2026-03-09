module.exports = {
  vip: {
    baseUrl: "https://phumikhmer.vip",
    articleSelector: "article",
    titleSelector: "h2 a, h3 a",
    posterSelector: "a.img-holder",
    posterAttrs: ["data-src", "data-bsrjs"],
	pageSize: 30
  },

  sunday: {
    baseUrl: "https://www.sundaydrama.com",
    articleSelector: "div.blog-posts div.entry-inner",
    titleSelector: "a.entry-image-wrap",
    posterSelector: "a.entry-image-wrap span, a.entry-image-wrap img",
    posterAttrs: ["data-src", "src"],
    pageSize: 30
  },

  idrama: {
    baseUrl: "https://www.idramahd.com",
    articleSelector: "article.hitmag-post",
    titleSelector: "h3.entry-title a",
    posterSelector: ".archive-thumb img",
    posterAttrs: ["data-src", "src"],
	pageSize: 30
  },

  khmerave: {
    baseUrl: "https://www.khmeravenue.com/album/",
	pageSize: 18
  },

  merlkon: {
    baseUrl: "https://www.khmerdrama.com/album/",
	pageSize: 18
  }
};