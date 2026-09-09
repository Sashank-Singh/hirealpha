import asyncio
import os
from browser_use import Agent
from browser_use.llm.litellm import ChatLiteLLM

async def main():
    api_key = os.environ.get("GMI_API_KEY")
    if not api_key:
        print("GMI_API_KEY not found in env")
        return

    llm = ChatLiteLLM(
        model="openai/moonshotai/Kimi-K2.5",
        api_base="https://api.gmi-serving.com/v1",
        api_key=api_key,
    )

    agent = Agent(
        task="Go to https://quotes.toscrape.com/login and inspect the form fields",
        llm=llm,
        use_vision=True,
    )
    history = await agent.run(max_steps=2)
    print("Browser-use execution success:", len(history.history) if hasattr(history, 'history') else history)

if __name__ == "__main__":
    asyncio.run(main())
