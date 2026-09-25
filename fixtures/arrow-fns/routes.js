const router = require("express").Router();

router.get("/ping", async (req, res) => {
  pong();
});

function pong() {}

module.exports = router;
