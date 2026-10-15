/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "warn",
      comment: "Circular imports make the flow hard to follow and hard to port.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      severity: "info",
      from: { orphan: true, pathNot: ["\.test\.ts$", "^src/index\.ts$", "\.d\.ts$"] },
      to: {},
    },
    {
      name: "db-does-not-import-routes",
      severity: "error",
      comment: "The data layer must not depend on HTTP code.",
      from: { path: "^src/db" },
      to: { path: "^src/(routes|middleware)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "\.test\.ts$" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    reporterOptions: {
      dot: { collapsePattern: "node_modules/(@[^/]+/[^/]+|[^/]+)" },
      archi: {
        collapsePattern: "^src/[^/]+",
      },
    },
  },
};
