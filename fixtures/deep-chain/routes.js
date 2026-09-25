const controller = require("./controller");

const router = require("express").Router();

router.get("/start", controller.begin);
router.get("/other", controller.side);

module.exports = router;
