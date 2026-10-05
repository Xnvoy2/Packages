/* The whole api, as one function.

   A catch-all rather than a file per route, for two reasons. The routing
   table in _server.js is the only description of what this api answers, and
   splitting it across files would create a second, silently divergent one.
   And a catch-all receives the original request path, so the table matches
   against exactly the url the caller asked for.

   Everything else here is deliberately absent: no route logic, no
   configuration, no error handling. This file exists to hand the request to
   the same handler the long-running server uses, so the two cannot behave
   differently.

   Sibling files are prefixed with an underscore (_lib, _routes, _server.js,
   _migrate.js) because every file under api/ would otherwise be published as
   its own endpoint. */

"use strict";

const { handleRequest } = require("./_server.js");

module.exports = (req, res) => handleRequest(req, res);
