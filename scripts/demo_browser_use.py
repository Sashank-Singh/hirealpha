import asyncio
import os
import sys
from kernel import Kernel
from browser_use import Browser, Agent
from browser_use.llm.litellm import ChatLiteLLM

async def main():
    gmi_api_key = os.environ.get("GMI_API_KEY")
    kernel_api_key = os.environ.get("KERNEL_API_KEY")
    
    for env_file in [".env", "spectrum/alpha/bench-runtime.env", "spectrum/alpha/.env"]:
        if os.path.exists(env_file):
            try:
                with open(env_file) as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith("GMI_API_KEY=") and not gmi_api_key:
                            gmi_api_key = line.split("=", 1)[1].strip()
                        elif line.startswith("KERNEL_API_KEY=") and not kernel_api_key:
                            kernel_api_key = line.split("=", 1)[1].strip()
            except Exception:
                pass

    if not gmi_api_key:
        print("GMI_API_KEY not found in env")
        return

    llm = ChatLiteLLM(
        model="openai/moonshotai/Kimi-K2.5",
        api_base="https://api.gmi-serving.com/v1",
        api_key=gmi_api_key,
    )

    kernel = None
    kernel_browser = None
    browser = None

    if kernel_api_key:
        print("Initializing Kernel cloud browser session...")
        try:
            kernel = Kernel(api_key=kernel_api_key)
            kernel_browser = kernel.browsers.create(
                headless=False,
                stealth=True,
                timeout_seconds=600,
                viewport={'width': 1280, 'height': 800},
            )
            print("=" * 70)
            print(f"KERNEL LIVE VIEW URL: {kernel_browser.browser_live_view_url}")
            print(f"Kernel Session ID: {kernel_browser.session_id}")
            print("=" * 70)
            browser = Browser(
                cdp_url=kernel_browser.cdp_ws_url,
                headless=False,
                window_size={'width': 1280, 'height': 800},
                viewport={'width': 1280, 'height': 800},
            )
        except Exception as e:
            print(f"Kernel launch error: {e}")
            browser = Browser(headless=False)
    else:
        print("No KERNEL_API_KEY; using local visible browser")
        browser = Browser(headless=False)

    try:
        agent = Agent(
            task="Go to https://quotes.toscrape.com/login and inspect the form fields",
            llm=llm,
            browser=browser,
            use_vision=True,
        )
        try:
            await agent.run(max_steps=2)
            print("Browser-use completed successfully!")
        except Exception as err:
            if "handshake" in str(err) or "CDP" in str(err):
                print("\n[NOTE] Port 8443 is blocked on this local network/Wi-Fi connection.")
                print("Kernel's direct CDP WebSocket (wss://...:8443) timed out.")
                print("Running visible browser locally on your Mac instead...")
                local_browser = Browser(headless=False)
                agent = Agent(
                    task="Go to https://quotes.toscrape.com/login and inspect the form fields",
                    llm=llm,
                    browser=local_browser,
                    use_vision=True,
                )
                await agent.run(max_steps=2)
                print("Local visible browser run completed!")
            else:
                raise err
    finally:
        try:
            if hasattr(browser, 'close'):
                await browser.close()
        except Exception:
            pass

        if kernel and kernel_browser:
            print("Cleaning up Kernel session...")
            try:
                kernel.browsers.delete_by_id(kernel_browser.session_id)
            except Exception:
                pass

if __name__ == "__main__":
    asyncio.run(main())
