import "./index.css"
import { Title, Meta } from "@solidjs/meta"
//import { HttpHeader } from "@solidjs/start"
import video from "../asset/lander/opencode-min.mp4"
import videoPoster from "../asset/lander/opencode-poster.png"
import { IconCopy, IconCheck } from "../component/icon"
import { A, createAsync } from "@solidjs/router"
import { EmailSignup } from "~/component/email-signup"
import { Tabs } from "@kobalte/core/tabs"
import { Faq } from "~/component/faq"
import { Header } from "~/component/header"
import { Footer } from "~/component/footer"
import { Legal } from "~/component/legal"
import { github } from "~/lib/github"
import { config } from "~/config"
import { useI18n } from "~/context/i18n"
import { useLanguage } from "~/context/language"
import { LocaleLinks } from "~/component/locale-links"

function CopyStatus() {
  return (
    <div data-component="copy-status">
      <IconCopy data-slot="copy" />
      <IconCheck data-slot="check" />
    </div>
  )
}

export default function Home() {
  const i18n = useI18n()
  const language = useLanguage()
  const _githubData = createAsync(() => github())
  const handleCopyClick = (event: Event) => {
    const button = event.currentTarget as HTMLButtonElement
    const text = button.textContent
    if (text) {
      void navigator.clipboard.writeText(text)
      button.setAttribute("data-copied", "")
      setTimeout(() => {
        button.removeAttribute("data-copied")
      }, 1500)
    }
  }

  return (
    <main data-page="opencode">
      {/*<HttpHeader name="Cache-Control" value="public, max-age=1, s-maxage=3600, stale-while-revalidate=86400" />*/}
      <Title>{i18n.t("home.title")}</Title>
      <LocaleLinks path="/" />
      <Meta property="og:image" content="/social-share.png" />
      <Meta name="twitter:image" content="/social-share.png" />
      <div data-component="container">
        <Header />

        <div data-component="content">
          <section data-component="hero">
            <div data-slot="hero-copy">
              {/*<a data-slot="releases"*/}
              {/*   href={release()?.url ?? `${config.github.repoUrl}/releases`}*/}
              {/*   target="_blank">*/}
              {/*  What’s new in {release()?.name ?? "the latest release"}*/}
              {/*</a>*/}
              <h1>{i18n.t("home.hero.title")}</h1>
              <p>
                {i18n.t("home.hero.subtitle.a")} <span data-slot="br"></span>
                {i18n.t("home.hero.subtitle.b")}
              </p>
            </div>
            <div data-slot="installation">
              <Tabs
                as="section"
                aria-label={i18n.t("home.install.ariaLabel")}
                class="tabs"
                data-component="tabs"
                data-active="curl"
                defaultValue="curl"
              >
                <Tabs.List data-slot="tablist">
                  <Tabs.Trigger value="curl" data-slot="tab">
                    curl
                  </Tabs.Trigger>
                  <Tabs.Trigger value="npm" data-slot="tab">
                    npm
                  </Tabs.Trigger>
                  <Tabs.Trigger value="bun" data-slot="tab">
                    bun
                  </Tabs.Trigger>
                  <Tabs.Trigger value="brew" data-slot="tab">
                    brew
                  </Tabs.Trigger>
                  <Tabs.Trigger value="paru" data-slot="tab">
                    paru
                  </Tabs.Trigger>
                  <Tabs.Indicator />
                </Tabs.List>
                <div data-slot="panels">
                  <Tabs.Content as="pre" data-slot="panel" value="curl">
                    <button data-copy data-slot="command" onClick={handleCopyClick}>
                      <span data-slot="command-script">
                        <span>curl -fsSL </span>
                        <span data-slot="protocol">https://</span>
                        <span data-slot="highlight">opencode.ai/install</span>
                        <span> | bash</span>
                      </span>
                      <CopyStatus />
                    </button>
                  </Tabs.Content>
                  <Tabs.Content as="pre" data-slot="panel" value="npm">
                    <button data-copy data-slot="command" onClick={handleCopyClick}>
                      <span>
                        <span data-slot="protocol">npm i -g </span>
                        <span data-slot="highlight">opencode-ai</span>
                      </span>
                      <CopyStatus />
                    </button>
                  </Tabs.Content>
                  <Tabs.Content as="pre" data-slot="panel" value="bun">
                    <button data-copy data-slot="command" onClick={handleCopyClick}>
                      <span>
                        <span data-slot="protocol">bun add -g </span>
                        <span data-slot="highlight">opencode-ai</span>
                      </span>
                      <CopyStatus />
                    </button>
                  </Tabs.Content>
                  <Tabs.Content as="pre" data-slot="panel" value="brew">
                    <button data-copy data-slot="command" onClick={handleCopyClick}>
                      <span>
                        <span data-slot="protocol">brew install </span>
                        <span data-slot="highlight">anomalyco/tap/opencode</span>
                      </span>
                      <CopyStatus />
                    </button>
                  </Tabs.Content>
                  <Tabs.Content as="pre" data-slot="panel" value="paru">
                    <button data-copy data-slot="command" onClick={handleCopyClick}>
                      <span>
                        <span data-slot="protocol">paru -S </span>
                        <span data-slot="highlight">opencode</span>
                      </span>
                      <CopyStatus />
                    </button>
                  </Tabs.Content>
                </div>
              </Tabs>
            </div>
          </section>

          <section data-component="video">
            <video src={video} autoplay playsinline loop muted preload="auto" poster={videoPoster}>
              {i18n.t("common.videoUnsupported")}
            </video>
          </section>

          <section data-component="what">
            <div data-slot="section-title">
              <h3>{i18n.t("home.what.title")}</h3>
              <p>{i18n.t("home.what.body")}</p>
            </div>
            <ul>
              <li>
                <span>[*]</span>
                <div>
                  <strong>{i18n.t("home.what.lsp.title")}</strong> {i18n.t("home.what.lsp.body")}
                </div>
              </li>
              <li>
                <span>[*]</span>
                <div>
                  <strong>{i18n.t("home.what.multiSession.title")}</strong> {i18n.t("home.what.multiSession.body")}
                </div>
              </li>
              <li>
                <span>[*]</span>
                <div>
                  <strong>{i18n.t("home.what.shareLinks.title")}</strong> {i18n.t("home.what.shareLinks.body")}
                </div>
              </li>
              <li>
                <span>[*]</span>
                <div>
                  <strong>{i18n.t("home.what.copilot.title")}</strong> {i18n.t("home.what.copilot.body")}
                </div>
              </li>
              <li>
                <span>[*]</span>
                <div>
                  <strong>{i18n.t("home.what.chatgptPlus.title")}</strong> {i18n.t("home.what.chatgptPlus.body")}
                </div>
              </li>
              <li>
                <span>[*]</span>
                <div>
                  <strong>{i18n.t("home.what.anyModel.title")}</strong> {i18n.t("home.what.anyModel.body")}
                </div>
              </li>
              <li>
                <span>[*]</span>
                <div>
                  <strong>{i18n.t("home.what.anyEditor.title")}</strong> {i18n.t("home.what.anyEditor.body")}
                </div>
              </li>
            </ul>
            <a href={language.route("/docs")}>
              <span>{i18n.t("home.what.readDocs")} </span>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path
                  d="M6.5 12L17 12M13 16.5L17.5 12L13 7.5"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="square"
                />
              </svg>
            </a>
          </section>

          <section data-component="privacy">
            <div data-slot="privacy-title">
              <h3>{i18n.t("home.privacy.title")}</h3>
              <div>
                <span>[*]</span>

                <p>
                  {i18n.t("home.privacy.body")} {i18n.t("home.privacy.learnMore")}{" "}
                  <a href={language.route("/docs")}>{i18n.t("home.privacy.link")}</a>.
                </p>
              </div>
            </div>
          </section>

          <section data-component="faq">
            <div data-slot="section-title">
              <h3>{i18n.t("common.faq")}</h3>
            </div>
            <ul>
              <li>
                <Faq question={i18n.t("home.faq.q1")}>{i18n.t("home.faq.a1")}</Faq>
              </li>
              <li>
                <Faq question={i18n.t("home.faq.q2")}>
                  {i18n.t("home.faq.a2.before")} <a href={language.route("/docs")}>{i18n.t("home.faq.a2.link")}</a>.
                </Faq>
              </li>
              <li>
                <Faq question={i18n.t("home.faq.q3")}>
                  {i18n.t("home.faq.a3.p1")} {i18n.t("home.faq.a3.p4.beforeLocal")}{" "}
                  <a href={language.route("/docs/providers/#lm-studio")} target="_blank">
                    {i18n.t("home.faq.a3.p4.localLink")}
                  </a>
                  .
                </Faq>
              </li>
              <li>
                <Faq question={i18n.t("home.faq.q4")}>
                  {i18n.t("home.faq.a4.p1")}{" "}
                  <a href={language.route("/docs/providers/#directory")}>{i18n.t("common.learnMore")}</a>.
                </Faq>
              </li>
              <li>
                <Faq question={i18n.t("home.faq.q5")}>
                  {i18n.t("home.faq.a5.beforeDesktop")} {i18n.t("home.faq.a5.desktop")} {i18n.t("home.faq.a5.and")}{" "}
                  <a href={language.route("/docs/web")}>{i18n.t("home.faq.a5.web")}</a>!
                </Faq>
              </li>
              <li>
                <Faq question={i18n.t("home.faq.q6")}>{i18n.t("home.faq.a6")}</Faq>
              </li>
              <li>
                <Faq question={i18n.t("home.faq.q7")}>
                  {i18n.t("home.faq.a7.p1")} {i18n.t("home.faq.a7.p2.beforeModels")}{" "}
                  <a href={language.route("/docs")}>{i18n.t("home.faq.a7.p2.modelsLink")}</a>{" "}
                  {i18n.t("home.faq.a7.p2.and")}{" "}
                  <a href={language.route("/docs/share/#privacy")}>{i18n.t("home.faq.a7.p2.shareLink")}</a>.
                </Faq>
              </li>
              <li>
                <Faq question={i18n.t("home.faq.q8")}>
                  {i18n.t("home.faq.a8.p1")}{" "}
                  <a href={config.github.repoUrl} target="_blank">
                    {i18n.t("nav.github")}
                  </a>{" "}
                  {i18n.t("home.faq.a8.p2")}{" "}
                  <a href={`${config.github.repoUrl}?tab=MIT-1-ov-file#readme`} target="_blank">
                    {i18n.t("home.faq.a8.mitLicense")}
                  </a>
                  {i18n.t("home.faq.a8.p3")}
                </Faq>
              </li>
            </ul>
          </section>

          <EmailSignup />

          <Footer />
        </div>
      </div>
      <Legal />
    </main>
  )
}
