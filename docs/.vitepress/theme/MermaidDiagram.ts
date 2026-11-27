import { defineComponent, h, onMounted, ref, watch } from "vue";
import { useData } from "vitepress";

let diagramCount = 0;

/**
 * Renders one ```mermaid code fence (see `markdown.config` in ../config.ts).
 *
 * mermaid is imported lazily on mount, so only pages that actually have a
 * diagram download it. If a diagram fails to render, its source is shown as a
 * code block instead of an empty box.
 */
export default defineComponent({
  name: "MermaidDiagram",
  props: {
    /** The fence body, URI-encoded so it survives as a Vue template attribute. */
    code: { type: String, required: true },
  },
  setup(props) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Vue composable in setup(), not a React hook
    const { isDark } = useData();
    const svg = ref("");
    const failed = ref(false);
    const source = decodeURIComponent(props.code);

    async function render() {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          // We show the source ourselves when a diagram fails, so skip mermaid's
          // own error graphic (it would be left at the bottom of <body>).
          suppressErrorRendering: true,
          theme: isDark.value ? "dark" : "default",
          // `.vp-doc p` sets a 28px line height, which also hits the <p> inside
          // mermaid's HTML labels. Mermaid sizes label boxes for a 1.5 line height,
          // so the last line of multi-line labels got cut off. Mermaid scopes this
          // CSS to the diagram's own SVG.
          themeCSS: "p { line-height: 1.5; }",
        });
        const { svg: rendered } = await mermaid.render(`mermaid-${++diagramCount}`, source);
        svg.value = rendered;
        failed.value = false;
      } catch (error) {
        console.error("Failed to render mermaid diagram", error);
        failed.value = true;
      }
    }

    onMounted(render);
    watch(isDark, render);

    return () =>
      failed.value
        ? h("pre", { class: "mermaid-error" }, h("code", source))
        : h("div", { class: "mermaid", innerHTML: svg.value });
  },
});
