# MCP Broker compatibility badge

A compact blue badge placed next to the npm badge in a repository README.

![mcp-broker: 1.6.1](mcp-broker-1.6.1.svg)

The number identifies the broker version supported by the repository. It must be chosen from integration results, not copied automatically from the latest broker release. The badge is a compatibility declaration, not a certification. The 1.6.1 artwork is a proposal; adding it to a provider repository requires verifying that repository against this version first.

## Ready-to-use Shields.io version

Shields.io supports custom static labels, messages, and colors. This URL works without publishing the local artwork:

```markdown
[![npm](https://img.shields.io/npm/v/@cyanmycelium/YOUR-PACKAGE)](https://www.npmjs.com/package/@cyanmycelium/YOUR-PACKAGE)
[![mcp-broker: 1.6.1](https://img.shields.io/badge/mcp--broker-1.6.1-008cff?labelColor=0756a6)](https://github.com/pandaGaume/mcp-broker)
```

Replace `YOUR-PACKAGE` with the repository's published npm package and `1.6.1` with its verified broker version. Consecutive Markdown image links without a blank line appear beside each other when rendered by GitHub.

Reference: https://shields.io/docs/static-badges

## Local custom SVG

Copy `mcp-broker-1.6.1.svg` into the consuming repository, then use its relative path:

```markdown
[![mcp-broker: 1.6.1](docs/assets/badges/mcp-broker-1.6.1.svg)](https://github.com/pandaGaume/mcp-broker)
```

Keep the displayed version, SVG title, filename, and Markdown alternative text consistent when updating it. The badge is self-contained and uses no external images, scripts, or fonts.

## Family emblem concept

`mcp-broker-family-concept.png` is a separate optional ecosystem emblem. It is not the compact README badge.

Generated with the built-in ImageGen tool from `docs/assets/logo.png` as a reference. Prompt: a transparent pixel-art hexagonal emblem with a navy center, blue and cyan border, the original blue octopus, exact text MCP BROKER / FAMILY, no version and no certification claim.

## Installed family assets

The canonical logo is `../mcp-broker-family.png`. Each `mcp-*` checkout carries an identical copy, displayed beside its project logo at 64 pixels wide. If a README has no project logo, the family emblem is displayed alone.

The compact `../mcp-broker-badge.svg` stays next to npm and displays the exact locally installed broker dependency version, or the pinned broker submodule version. When there is no local broker dependency, the version of the adjacent `mcp-broker` source checkout is used, as requested. `family-repositories.json` records the source for every displayed version. It is not a certification badge.
