/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show } from "solid-js"

const LOGO = [
  "██████╗  ██████╗ ██████╗ ██╗   ██╗",
  "██╔════╝ ██╔═══██╗██╔══██╗██║   ██║",
  "╚█████╗  ██║   ██║██████╔╝██║   ██║",
  " ╚═══██╗ ██║   ██║██╔══██╗██║   ██║",
  "██████╔╝ ╚██████╔╝██║  ██║╚██████╔╝",
  "╚═════╝   ╚═════╝ ╚═╝  ╚═╝ ╚═════╝",
] as const

type Account = {
  state: "loading" | "ready" | "error"
  username?: string
  points?: number
  used?: number
  admin?: boolean
}

function number(value: number | undefined) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Number(value || 0))
}

function balance(account: Account) {
  if (account.state === "loading") return "loading points..."
  if (account.state === "error") return "points unavailable"
  if (account.admin) return "ADMIN | UNLIMITED"
  return `${number(account.points)} pts | ${number(account.used)} used`
}

function shortDirectory(value: string) {
  const home = String(process.env.USERPROFILE || process.env.HOME || "").replace(/\\/g, "/")
  let current = value.replace(/\\/g, "/")
  if (home && current.toLowerCase().startsWith(home.toLowerCase())) current = `~${current.slice(home.length)}`
  return current.length > 48 ? `...${current.slice(-45)}` : current
}

function Logo(props: { api: any }) {
  const theme = () => props.api.theme.current
  return (
    <box flexDirection="column" alignItems="flex-start">
      <For each={LOGO}>{(line) => <text fg={theme().success}>{line}</text>}</For>
    </box>
  )
}

function PointStatus(props: { api: any; account: () => Account }) {
  return <text fg={props.api.theme.current.textMuted}>{balance(props.account())}</text>
}

function Footer(props: { api: any; account: () => Account }) {
  const directory = () => shortDirectory(props.api.state.path.directory || process.cwd())
  const branch = () => props.api.state.vcs?.branch
  const version = String(process.env.EMPER_CLI_VERSION || "")
  return (
    <box
      width="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="row"
      flexShrink={0}
      gap={1}
    >
      <text fg={props.api.theme.current.textMuted}>
        {directory()}<Show when={branch()}>:{branch()}</Show>
      </text>
      <box flexGrow={1} />
      <text fg={props.api.theme.current.success}>SORU</text>
      <text fg={props.api.theme.current.textMuted}>Emper Code {version}</text>
    </box>
  )
}

export default {
  id: "emper.tui",
  async tui(api: any) {
    const [account, setAccount] = createSignal<Account>({ state:"loading" })
    let refreshing = false

    const refresh = async () => {
      if (refreshing) return
      refreshing = true
      try {
        const base = String(process.env.EMPER_API_URL || "").replace(/\/$/, "")
        const key = String(process.env.EMPER_API_KEY || "")
        if (!base || !key) throw new Error("missing account configuration")
        const response = await fetch(`${base}/me`, {
          headers:{ Accept:"application/json", Authorization:`Bearer ${key}` },
          signal:AbortSignal.timeout(8000),
        })
        if (!response.ok) throw new Error("account request failed")
        const data = await response.json()
        setAccount({
          state:"ready",
          username:String(data.username || ""),
          points:Number(data.points || 0),
          used:Number(data.total_points_used || 0),
          admin:Boolean(data.is_admin),
        })
        api.renderer.setTerminalTitle("Emper Code")
      } catch {
        setAccount({ state:"error" })
      } finally {
        refreshing = false
      }
    }

    api.renderer.setTerminalTitle("Emper Code")
    api.kv.set("tips_hidden", true)
    api.slots.register({
      order:-1000000,
      slots:{
        home_logo() {
          return <Logo api={api} />
        },
        home_prompt_right() {
          return <PointStatus api={api} account={account} />
        },
        session_prompt_right() {
          return <PointStatus api={api} account={account} />
        },
        home_footer() {
          return <Footer api={api} account={account} />
        },
      },
    })

    const disposeCommand = api.command?.register(() => [{
      title:"Show Emper points",
      value:"emper.points",
      description:"Refresh account balance",
      category:"Emper",
      slash:{ name:"points", aliases:["balance"] },
      onSelect() {
        void refresh().then(() => api.ui.toast({
          variant:account().state === "error" ? "error" : "info",
          title:"Emper account",
          message:balance(account()),
        }))
      },
    }])

    const timer = setInterval(() => void refresh(), 15000)
    api.lifecycle.onDispose(() => {
      clearInterval(timer)
      disposeCommand?.()
    })
    void refresh()
  },
}
