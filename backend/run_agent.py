import uuid

from callbacks.langgraph_callback import AgentMonitorCallback
from agents.research_agent import build_graph


def run_monitored_agent(
    user_input: str,
    agent_id: str = "research_agent",
    session_id: str = "demo_session_001",
):
    run_id = str(uuid.uuid4())
    callback = AgentMonitorCallback(run_id=run_id, agent_id=agent_id, session_id=session_id)
    graph = build_graph()
    return graph.invoke({"input": user_input}, config={"callbacks": [callback]})


if __name__ == "__main__":
    result = run_monitored_agent("Summarize the latest run state.")
    print(result)
