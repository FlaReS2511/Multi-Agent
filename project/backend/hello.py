import sys


def greet(name: str) -> str:
    return f"Hello, {name}!"


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: hello.py <name>")
        sys.exit(1)
    print(greet(sys.argv[1]))
