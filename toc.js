// Populate the sidebar
//
// This is a script, and not included directly in the page, to control the total size of the book.
// The TOC contains an entry for each page, so if each page includes a copy of the TOC,
// the total size of the page becomes O(n**2).
class MDBookSidebarScrollbox extends HTMLElement {
    constructor() {
        super();
    }
    connectedCallback() {
        this.innerHTML = '<ol class="chapter"><li class="chapter-item expanded affix "><a href="index.html">设计文档总览</a></li><li class="chapter-item expanded affix "><li class="part-title">Gitea Pages</li><li class="chapter-item expanded "><a href="pages/index.html"><strong aria-hidden="true">1.</strong> 总体设计</a></li><li class="chapter-item expanded "><a href="pages/implementation.html"><strong aria-hidden="true">2.</strong> 实施准备与工程入口</a></li><li class="chapter-item expanded "><a href="pages/github-pages-research.html"><strong aria-hidden="true">3.</strong> GitHub Pages 调研与功能评估</a></li><li class="chapter-item expanded "><a href="pages/communication.html"><strong aria-hidden="true">4.</strong> 通信、同步与状态展示</a></li><li class="chapter-item expanded "><a href="pages/publishing.html"><strong aria-hidden="true">5.</strong> 发布、TAR.GZ 存储与访问</a></li><li class="chapter-item expanded "><a href="pages/access-and-domains.html"><strong aria-hidden="true">6.</strong> 公开访问、自定义域名与 HTTP/HTTPS</a></li><li class="chapter-item expanded "><a href="pages/certificates.html"><strong aria-hidden="true">7.</strong> 证书管理与部署</a></li><li class="chapter-item expanded "><a href="pages/lifecycle.html"><strong aria-hidden="true">8.</strong> 生命周期与故障恢复</a></li><li class="chapter-item expanded "><a href="pages/data-and-validation.html"><strong aria-hidden="true">9.</strong> 数据、Pages 本地架构与验证</a></li><li class="chapter-item expanded affix "><li class="spacer"></li><li class="chapter-item expanded affix "><li class="part-title">Gitea Codespace</li><li class="chapter-item expanded "><a href="codespace/index.html"><strong aria-hidden="true">10.</strong> 总体设计</a></li><li class="chapter-item expanded "><a href="codespace/gitea-server.html"><strong aria-hidden="true">11.</strong> Gitea 服务端</a></li><li class="chapter-item expanded "><a href="codespace/runtime-platform.html"><strong aria-hidden="true">12.</strong> 运行平台</a></li><li class="chapter-item expanded "><a href="codespace/lifecycle.html"><strong aria-hidden="true">13.</strong> 生命周期</a></li><li class="chapter-item expanded "><a href="codespace/data-model.html"><strong aria-hidden="true">14.</strong> 数据模型</a></li><li class="chapter-item expanded "><a href="codespace/rpc-spec.html"><strong aria-hidden="true">15.</strong> RPC 接口</a></li><li class="chapter-item expanded "><a href="codespace/deployment-requirements.html"><strong aria-hidden="true">16.</strong> 部署要求</a></li><li class="chapter-item expanded "><a href="codespace/implementation.html"><strong aria-hidden="true">17.</strong> 实施与测试</a></li></ol>';
        // Set the current, active page, and reveal it if it's hidden
        let current_page = document.location.href.toString().split("#")[0];
        if (current_page.endsWith("/")) {
            current_page += "index.html";
        }
        var links = Array.prototype.slice.call(this.querySelectorAll("a"));
        var l = links.length;
        for (var i = 0; i < l; ++i) {
            var link = links[i];
            var href = link.getAttribute("href");
            if (href && !href.startsWith("#") && !/^(?:[a-z+]+:)?\/\//.test(href)) {
                link.href = path_to_root + href;
            }
            // The "index" page is supposed to alias the first chapter in the book.
            if (link.href === current_page || (i === 0 && path_to_root === "" && current_page.endsWith("/index.html"))) {
                link.classList.add("active");
                var parent = link.parentElement;
                if (parent && parent.classList.contains("chapter-item")) {
                    parent.classList.add("expanded");
                }
                while (parent) {
                    if (parent.tagName === "LI" && parent.previousElementSibling) {
                        if (parent.previousElementSibling.classList.contains("chapter-item")) {
                            parent.previousElementSibling.classList.add("expanded");
                        }
                    }
                    parent = parent.parentElement;
                }
            }
        }
        // Track and set sidebar scroll position
        this.addEventListener('click', function(e) {
            if (e.target.tagName === 'A') {
                sessionStorage.setItem('sidebar-scroll', this.scrollTop);
            }
        }, { passive: true });
        var sidebarScrollTop = sessionStorage.getItem('sidebar-scroll');
        sessionStorage.removeItem('sidebar-scroll');
        if (sidebarScrollTop) {
            // preserve sidebar scroll position when navigating via links within sidebar
            this.scrollTop = sidebarScrollTop;
        } else {
            // scroll sidebar to current active section when navigating via "next/previous chapter" buttons
            var activeSection = document.querySelector('#sidebar .active');
            if (activeSection) {
                activeSection.scrollIntoView({ block: 'center' });
            }
        }
        // Toggle buttons
        var sidebarAnchorToggles = document.querySelectorAll('#sidebar a.toggle');
        function toggleSection(ev) {
            ev.currentTarget.parentElement.classList.toggle('expanded');
        }
        Array.from(sidebarAnchorToggles).forEach(function (el) {
            el.addEventListener('click', toggleSection);
        });
    }
}
window.customElements.define("mdbook-sidebar-scrollbox", MDBookSidebarScrollbox);
