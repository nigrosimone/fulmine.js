// The default theme without its bundled Inter: the system font stack costs no download, and the
// page paints on the first frame instead of after 67 KiB of woff2.
import DefaultTheme from "vitepress/theme-without-fonts";
import { defineComponent, h, onMounted, watch } from "vue";
import { useRoute } from "vitepress";
import "./custom.css";

/** The home layout has no <main>, so the landmark is put on it once it is in the document. */
function markMain() {
    document.querySelector(".VPHome")?.setAttribute("role", "main");
}

const Layout = defineComponent({
    setup() {
        const route = useRoute();
        onMounted(markMain);
        watch(
            () => route.path,
            () => setTimeout(markMain, 0)
        );
        return () => h(DefaultTheme.Layout);
    }
});

export default { extends: DefaultTheme, Layout };
