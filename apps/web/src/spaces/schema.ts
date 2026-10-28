import { getSchema, Mark, Node, type Extensions } from "@tiptap/core";

import type { SpaceBlock, SpaceKnownMark } from "@t2code/contracts/spaces";

const blockAttributes = () => ({ block: { default: null, rendered: false } });
const listTypes = new Set(["bulleted_item", "numbered_item", "todo_item"]);
export const richBlockTypes = [
  "paragraph",
  "heading",
  "quote",
  "callout",
  "bulleted_item",
  "numbered_item",
  "todo_item",
] as const;

export const spaceSchemaExtensions: Extensions = [
  Node.create({ name: "doc", topNode: true, content: "spaceBlock*" }),
  Node.create({ name: "text", group: "inline" }),
  Node.create({
    name: "spaceBody",
    content: "inline*",
    defining: true,
    renderHTML: () => ["div", { "data-space-body": "", style: "white-space: pre-wrap" }, 0],
  }),
  ...richBlockTypes.map((name) =>
    Node.create({
      name,
      group: "spaceBlock",
      defining: true,
      content: listTypes.has(name) ? "spaceBody spaceBlock*" : "inline*",
      addAttributes: blockAttributes,
      renderHTML({ node }) {
        const block = node.attrs.block as SpaceBlock;
        const tag = name === "heading" ? "h2" : name === "quote" ? "blockquote" : "div";
        return [
          tag,
          { "data-space-block": block.id, "data-space-type": name, style: "white-space: pre-wrap" },
          0,
        ];
      },
    }),
  ),
  Node.create({
    name: "code",
    group: "spaceBlock",
    content: "text*",
    marks: "",
    code: true,
    defining: true,
    addAttributes: blockAttributes,
    renderHTML: ({ node }) => [
      "pre",
      { "data-space-block": (node.attrs.block as SpaceBlock).id },
      ["code", {}, 0],
    ],
  }),
  Node.create({
    name: "spaceAtom",
    group: "spaceBlock",
    atom: true,
    selectable: true,
    isolating: true,
    addAttributes: blockAttributes,
    renderHTML({ node }) {
      const block = node.attrs.block as SpaceBlock;
      return [
        "div",
        { "data-space-block": block.id, contenteditable: "false" },
        `${block.type} (read only)`,
      ];
    },
  }),
  ...(["bold", "italic", "strike", "code", "link", "page_mention", "block_mention"] as const).map(
    (name) =>
      Mark.create({
        name: `space_${name}`,
        inclusive: name !== "link" && !name.endsWith("mention"),
        excludes: `space_${name}`,
        addAttributes: () => ({ value: { default: null, rendered: false } }),
        renderHTML({ mark }) {
          const value = mark.attrs.value as SpaceKnownMark;
          if (value.type === "link")
            return ["a", { href: value.href, rel: "noopener noreferrer" }, 0];
          const tag =
            { bold: "strong", italic: "em", strike: "s", code: "code" }[
              name as "bold" | "italic" | "strike" | "code"
            ] ?? "span";
          return [tag, {}, 0];
        },
      }),
  ),
];

export const spaceSchema = getSchema(spaceSchemaExtensions);
