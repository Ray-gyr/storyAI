"""检索实验的共享工具：语料加载与分词（BM25 与 IDF 分析共用同一套分词）"""
import json
import math
import re
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent / "out"

# 常见英文停用词：只去掉功能词，事件词（动词/名词）全部保留
STOPWORDS = set("""
a an the and or but if then so than that this these those there here of to in on at by for with from into onto
upon about over under after before during while as is are was were be been being am do does did doing have has had
having it its it's he him his she her hers they them their theirs we us our you your yours i me my mine who whom whose
which what when where why how not no nor all any both each few more most other some such only own same too very can
will just should would could may might must shall also up down out off again further once s t
""".split())

TOKEN_RE = re.compile(r"[a-z0-9]+")

# 实验故事的主角（见 generate_story.ts 的 STORY_SETTING）
PROTAGONIST = "Mara Voss"

# 角色名里的头衔 / 修饰词，不能代表某个具体实体
TITLE_WORDS = {"sister", "lord", "lady", "old", "captain", "brother", "father", "mother", "sir", "master", "young"}


def tokenize(text: str) -> list[str]:
    """小写 + 按非字母数字切分 + 去停用词（所有格 's 会被切成单独的 s，随停用词一起去掉）"""
    return [t for t in TOKEN_RE.findall(text.lower()) if t not in STOPWORDS]


def load_corpus() -> dict:
    return json.loads((OUT_DIR / "corpus.json").read_text(encoding="utf-8"))


TURN_MARKER_RE = re.compile(r"\[Turn \d+\] (USER|ASSISTANT|SYSTEM):")


def doc_text(chunk: dict, field: str) -> str:
    text = chunk.get(field) or ""
    if field == "original_text":
        # 去掉与相邻片段重叠的上下文（否则同一段剧情会被重复计入 df），以及轮次标记
        if "[Content to Extract]" in text:
            text = text.split("[Content to Extract]", 1)[1]
        text = TURN_MARKER_RE.sub(" ", text)
    return text


def entity_names(final_state: dict) -> dict[str, list[str]]:
    """按类型返回世界状态中登记的全部实体名"""
    return {
        "character": [e["name"] for e in final_state.get("known_characters", [])],
        "location": [e["name"] for e in final_state.get("known_locations", [])],
        "item": [e["name"] for e in final_state.get("known_items", [])],
    }


def lucene_idf(n_docs: int, df: int) -> float:
    """Lucene / Elasticsearch 的 BM25 IDF：log(1 + (N - n + 0.5) / (n + 0.5))，恒为正"""
    return math.log(1 + (n_docs - df + 0.5) / (df + 0.5))


def okapi_raw_idf(n_docs: int, df: int) -> float:
    """rank_bm25.BM25Okapi 的原始 IDF：log(N - n + 0.5) - log(n + 0.5)，df 超过一半时为负"""
    return math.log(n_docs - df + 0.5) - math.log(df + 0.5)
