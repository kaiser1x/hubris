function alpha() {
  console.log("a");
  bravo();
}

function bravo() {
  charlie();
}

function charlie() {
  delta();
}

function delta() {
  require("./side-effect");
  echo();
  zulu();
}

function echo() {
  foxtrot();
}

function foxtrot() {
  golf();
  charlie();
}

function golf() {
  hotel();
}

function hotel() {
  india();
}

function india() {
  juliet();
}

function juliet() {
}

function zulu() {
}

function lonely() {
}

module.exports = {
  alpha,
  bravo,
  charlie,
  delta,
  echo,
  foxtrot,
  golf,
  hotel,
  india,
  juliet,
  zulu,
  lonely,
};
