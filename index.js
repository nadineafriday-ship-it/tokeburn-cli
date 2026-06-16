"use strict";

// Public package entry. Exposes the SDK wrapper so consumers can:
//   const { withTokeburn } = require("tokeburn");
//   import { withTokeburn } from "tokeburn";
const { withTokeburn } = require("./src/sdk");

module.exports = { withTokeburn };
