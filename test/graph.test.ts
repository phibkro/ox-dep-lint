/** Tarjan's components and the cycle routes behind `package-cycle`, which must read as 0.2's depth-first search did. */
import { describe, expect, it } from "vite-plus/test"
import { checkWorkspace } from "../src/check.ts"
import { stronglyConnectedComponents } from "../src/graph.ts"
import { removeWorkspace, validConfig, validWorkspace, writeWorkspace } from "./support/workspace.ts"

const graph = (edges: Record<string, readonly string[]>) => new Map(Object.entries(edges))

const sortedComponents = (components: readonly (readonly string[])[]) => components.map((component) => component.toSorted().join(" ")).toSorted()

describe("strongly connected components", () => {
  it("finds every component, each before the components that reach it", () => {
    const edges = graph({ a: ["b"], b: ["c", "d"], c: ["a"], d: ["e"], e: ["d", "f"], f: [] })
    const { components } = stronglyConnectedComponents(["a", "b", "c", "d", "e", "f"], edges)

    expect(sortedComponents(components)).toEqual(["a b c", "d e", "f"])
    expect(components.map((component) => component.toSorted().join(" "))).toEqual(["f", "d e", "a b c"])
  })

  it("closes one route per back edge, in the order the search closes them", () => {
    // a holds two cycles (a b and a d); the cycle c e is reached between them.
    const edges = graph({ a: ["b", "c", "d"], b: ["a"], c: ["e"], e: ["c"], d: ["a"] })
    const { components, routes } = stronglyConnectedComponents(["a", "b", "c", "d", "e"], edges)

    expect(sortedComponents(components)).toEqual(["a b d", "c e"])
    expect(routes).toEqual([
      ["a", "b", "a"],
      ["c", "e", "c"],
      ["a", "d", "a"],
    ])
  })

  it("starts each route at the node the search reached first, following successors in order", () => {
    const edges = graph({ x: ["z"], y: ["x"], z: ["y"] })

    expect(stronglyConnectedComponents(["y", "x", "z"], edges).routes).toEqual([["y", "x", "z", "y"]])
    expect(stronglyConnectedComponents(["x", "y", "z"], edges).routes).toEqual([["x", "z", "y", "x"]])
  })

  it("walks a cycle of 100000 nodes without exhausting the stack", () => {
    const size = 100_000
    const names = Array.from({ length: size }, (_, index) => `node${index}`)
    const edges = new Map(names.map((name, index) => [name, [names[(index + 1) % size] ?? ""]]))
    const { components, routes } = stronglyConnectedComponents(names, edges)

    expect(components).toHaveLength(1)
    expect(routes).toHaveLength(1)
    expect(routes[0]).toHaveLength(size + 1)
  })
})

describe("package cycles", () => {
  it("reports a cycle across three packages and a separate one, with the routes and files of 0.2", () => {
    const root = writeWorkspace({
      ...validWorkspace,
      "libraries/parcel/package.json": { name: "@acme/parcel", dependencies: { effect: "1", "@acme/conformance": "workspace:*" } },
      "libraries/conformance/package.json": { name: "@acme/conformance", dependencies: { "fast-check": "1", "@acme/extra": "workspace:*" } },
      "libraries/extra/package.json": { name: "@acme/extra", dependencies: { "@acme/parcel": "workspace:*" } },
      "services/quota/package.json": { name: "@acme/service-quota", dependencies: { "@acme/parcel": "workspace:*", "@acme/service-room": "workspace:*" } },
      "services/room/package.json": {
        name: "@acme/service-room",
        dependencies: { "@acme/parcel": "workspace:*", effect: "1", "@acme/service-quota": "workspace:*" },
        devDependencies: { "@acme/conformance": "workspace:*" },
      },
    })

    try {
      const cycles = checkWorkspace(root, validConfig).findings.filter((finding) => finding.rule === "package-cycle")
      expect(cycles.map((finding) => `${finding.file} ${finding.message}`)).toEqual([
        "libraries/conformance/package.json dependency cycle: @acme/conformance -> @acme/extra -> @acme/parcel -> @acme/conformance",
        "services/quota/package.json dependency cycle: @acme/service-quota -> @acme/service-room -> @acme/service-quota",
      ])
    } finally {
      removeWorkspace(root)
    }
  })
})
