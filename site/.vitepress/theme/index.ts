// The default theme without its bundled Inter: the system font stack costs no download, and the
// page paints on the first frame instead of after 67 KiB of woff2.
import DefaultTheme from "vitepress/theme-without-fonts";
import "./custom.css";

export default { extends: DefaultTheme };
