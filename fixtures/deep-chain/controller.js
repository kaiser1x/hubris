const chain = require("./chain");

exports.begin = function begin() {
  console.log("start");
  chain.alpha();
};

exports.side = function side() {
  chain.lonely();
};
