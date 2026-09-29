开始后端代码编写，实现 Jev 多模型智能路由中枢。需包含以下四个模块，并使用配置文件持久化相关配置信息：

一、模型配置文件：记录系统模型信息，供代码实际执行调用。包含：
1. Jev：url 为 https://api.typesafe.ai/v1/systemone，APIKEY 通过环境变量 JEV_API_KEY 注入（不在仓库中明文保存）。
2. LLM 模型库：Key 通过环境变量 LLM_API_KEY 注入，基础 URL 为 http://127.0.0.1:8788/v1，Models API 为 http://127.0.0.1:8788/v1/models，Chat Completions API 为 /v1/chat/completions，Responses API 为 /v1/responses。

二、决策信息库：用 json 文件存储 Jev 的决策信息，决策模式参考 D:\TREAWork\JevOmniRouter\openspec\changes\jev-router-fusion 下的相关文档；每次 Prompt 输入完成模型智能路由决策后，热更新该决策信息文件。

三、模型信息库：从模型配置文件读取对应模型清单，并参考上述目录文档及网络信息，对模型进行决策区分度评分。

四、历史库：记录每次 Prompt 输入执行的信息，存储为 json 文件，按小时拆分文件。

执行流程：用户在 Prompt 输入信息后，Jev 多模型智能路由中枢分析输入信息，通过决策信息库计算置信度路由阈值，依据该阈值调用对应 LLM 模型执行；执行信息在“Jev 智能路由选择”区域展示，并将本次执行结果更新至决策信息库、记录至历史库。