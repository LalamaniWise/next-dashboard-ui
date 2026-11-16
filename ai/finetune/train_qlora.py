"""Fine-tune an open model on the CAPS tutor data with QLoRA.

QLoRA loads the base model in 4-bit and trains small "adapter" weights on top,
so a 7-8B model trains on ONE GPU (24-80 GB). The result is a folder of adapter
weights (a few hundred MB) that you load together with the base model.

    pip install -r requirements.txt
    python train_qlora.py --train data/train.jsonl --val data/val.jsonl \
        --base Qwen/Qwen2.5-7B-Instruct --out outputs/school-tutor

Base model: pick an instruction-tuned open model with a licence that allows
your use. Qwen and Llama models handle English well; test Afrikaans on the
base model first (see eval.py) and choose the one that does best.
"""

import argparse

import torch
from datasets import load_dataset
from peft import LoraConfig
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import SFTConfig, SFTTrainer


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True)
    ap.add_argument("--val", required=True)
    ap.add_argument("--base", default="Qwen/Qwen2.5-7B-Instruct")
    ap.add_argument("--out", default="outputs/school-tutor")
    ap.add_argument("--epochs", type=float, default=2)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--max-len", type=int, default=2048)
    ap.add_argument("--batch", type=int, default=2)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--no-4bit", action="store_true", help="load full precision (testing / CPU)")
    a = ap.parse_args()

    tokenizer = AutoTokenizer.from_pretrained(a.base)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    quant = None if a.no_4bit else BitsAndBytesConfig(
        load_in_4bit=True, bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    model = AutoModelForCausalLM.from_pretrained(
        a.base,
        quantization_config=quant,
        dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
        device_map="auto" if torch.cuda.is_available() else None,
    )

    data = load_dataset("json", data_files={"train": a.train, "val": a.val})
    # Prompt = system + question, completion = tutor answer. TRL then trains on
    # the completion only, so the model learns to answer, not to write questions.
    data = data.map(
        lambda r: {"prompt": r["messages"][:-1], "completion": r["messages"][-1:]},
        remove_columns=data["train"].column_names,
    )

    trainer = SFTTrainer(
        model=model,
        processing_class=tokenizer,
        train_dataset=data["train"],
        eval_dataset=data["val"],
        peft_config=LoraConfig(
            r=16, lora_alpha=32, lora_dropout=0.05, task_type="CAUSAL_LM",
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                            "gate_proj", "up_proj", "down_proj"]),
        args=SFTConfig(
            output_dir=a.out,
            num_train_epochs=a.epochs,
            learning_rate=a.lr,
            per_device_train_batch_size=a.batch,
            per_device_eval_batch_size=a.batch,
            gradient_accumulation_steps=a.grad_accum,
            gradient_checkpointing=True,
            max_length=a.max_len,
            lr_scheduler_type="cosine",
            warmup_steps=0.03,  # fraction of training used for warm-up
            bf16=torch.cuda.is_available(),
            logging_steps=10,
            eval_strategy="epoch",
            save_strategy="epoch",
            save_total_limit=2,
            report_to="none",
        ),
    )
    trainer.train()
    trainer.save_model(a.out)
    tokenizer.save_pretrained(a.out)
    print(f"adapter saved to {a.out}")


if __name__ == "__main__":
    main()
