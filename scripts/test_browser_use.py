import asyncio
import os
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

    print(f"KERNEL_API_KEY found: {bool(kernel_api_key)}")

    llm = ChatLiteLLM(
        model="openai/moonshotai/Kimi-K2.5",
        api_base="https://api.gmi-serving.com/v1",
        api_key=gmi_api_key,
    )

    kernel = None
    kernel_browser = None
    browser = None

    if kernel_api_key:
        print("Initializing Kernel client...")
        kernel = Kernel(api_key=kernel_api_key)
        print("Creating Kernel stealth browser session...")
        kernel_browser = kernel.browsers.create(
            headless=False,
            stealth=True,
            timeout_seconds=600,
            viewport={'width': 1280, 'height': 800},
        )
        print("=" * 70)
        print(f"KERNEL LIVE VIEW URL: {kernel_browser.browser_live_view_url}")
        print("=" * 70)
        print(f"Kernel Session ID: {kernel_browser.session_id}")
        print(f"Kernel CDP URL: {kernel_browser.cdp_ws_url}")

        browser = Browser(
            cdp_url=kernel_browser.cdp_ws_url,
            headless=False,
            window_size={'width': 1280, 'height': 800},
            viewport={'width': 1280, 'height': 800},
            device_scale_factor=1.0,
        )
    else:
        print("KERNEL_API_KEY not set; using local browser")
        browser = Browser(headless=True)

    try:
        agent = Agent(
            task="Go to https://quotes.toscrape.com/login and inspect the form fields",
            llm=llm,
            browser=browser,
            use_vision=True,
        )
        history = await agent.run(max_steps=2)
        print("Browser-use execution completed!")
        if kernel_browser:
            print("=" * 70)
            print(f"LIVE VIEW IS STILL ACTIVE: {kernel_browser.browser_live_view_url}")
            print("Keeping session alive for 3 minutes for you to inspect...")
            print("=" * 70)
            await asyncio.sleep(180)
    finally:
        try:
            if hasattr(browser, 'close'):
                await browser.close()
        except Exception as e:
            print(f"Browser close error: {e}")

        if kernel and kernel_browser:
            print("Cleaning up Kernel session...")
            try:
                kernel.browsers.delete_by_id(kernel_browser.session_id)
            except Exception as e:
                print(f"Kernel cleanup error: {e}")

if __name__ == "__main__":
    asyncio.run(main())

