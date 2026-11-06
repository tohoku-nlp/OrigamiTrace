# OrigamiTrace

**Origami as a Real-Image Benchmark for Procedural State-Transition Reasoning** (NeurIPS 2026, Track on Evaluations and Datasets)

Project page: https://tohoku-nlp.github.io/OrigamiTrace/

This repository contains the materials used in the simulator-based benchmark experiments of the paper: the system prompts, the simulator command specification and command examples, and the fixed messages sent to the LLM controllers.
The dataset itself is distributed separately through Harvard Dataverse (link coming soon).

## Directory Structure

```text
.
├─ README.md
├─ instructions/
│  ├─ task_1.md
│  └─ task_2.md
├─ knowledge/
│  ├─ command_specification.json
│  ├─ basic_examples.json
│  └─ additional_useful_examples.json
├─ messages/
│  ├─ task_1_initial.txt
│  ├─ task_1_retry_incorrect.txt
│  └─ task_1_retry_invalid.txt
└─ docs/                      # project page
```

## File Descriptions

- `instructions/task_1.md`, `instructions/task_2.md`
  System prompts for Task 1 and Task 2.
- `knowledge/command_specification.json`
  Simulator command specification: coordinate system, command invocation and return formats, fold specification schema, simulator conventions, and supported commands.
- `knowledge/basic_examples.json`, `knowledge/additional_useful_examples.json`
  Command examples for the commands defined in `command_specification.json`.
- `messages/task_1_initial.txt`
  First user message of a Task 1 episode. It is sent together with all reference images (as separate image files) and all textual entries (as a single CSV file).
- `messages/task_1_retry_incorrect.txt`, `messages/task_1_retry_invalid.txt`
  Fixed feedback sent in Task 1 after a failed attempt: when the resulting fold is judged incorrect, and when the command is invalid, respectively. No detailed simulator error messages are returned to the controller.

## How the Prompts Are Used

The three LLM controllers (GPT 5.6 Sol, Gemma 4 31B, and Gemma 3 12B IT) were accessed directly through their APIs: GPT 5.6 Sol through the OpenAI API, and Gemma 4 31B and Gemma 3 12B IT through Amazon Bedrock.
The same prompts, command interface, and attempt budget were used for all three controllers.

For each task, the system prompt sent to the controller is the content of `instructions/task_<N>.md` followed by the three files in `knowledge/`, each serialized as compact JSON under its own heading:

```text
<instructions/task_N.md>

# Command specification
<knowledge/command_specification.json>

# Basic examples
<knowledge/basic_examples.json>

# Additional useful examples
<knowledge/additional_useful_examples.json>
```
