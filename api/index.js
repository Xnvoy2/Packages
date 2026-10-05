/* The whole api, as one function.

   One entry rather than a file per route. The routing table in _server.js is
   the only description of what this api answers, and splitting it across
   files would create a second one that silently diverges.

   Every /api/* path is rewritten onto this file by vercel.json. The platform
   resolved a [...path] catch-all to a single segment, so /api/health reached
   the function while /api/packages/express did not: search, browse and every
   package page returned a platform 404 before any of this ran.

   Sibling files are prefixed with an underscore (_lib, _routes, _server.js,
   _migrate.js) because every file under api/ would otherwise be published as
   its own endpoint. This file is a handler, so publishing it is correct. */

"use strict";

const { handleRequest } = require("./_server.js");

module.exports = (req, res) => handleRequest(req, res);
