# =============================================================================
# libmcpb -- standalone build.
#
#   make            build the static library
#   make test       build and run the bench
#   make clean
#
# Deliberately self-contained: this directory ships on its own as an
# mcp-broker client, so it carries its own build rather than depending on the
# host project's. Nothing here refers to anything outside libmcpb/.
#
#   make CC=arm-none-eabi-gcc AR=arm-none-eabi-ar    cross-compiling
# =============================================================================

CC      ?= gcc
AR      ?= ar
CSTD    ?= -std=c99

# The same warnings the library is developed under. -Wconversion is not
# decoration here: this code shifts and masks its way through frame headers,
# and a silent narrowing is exactly how a length field gets truncated.
WARN    := -Wall -Wextra -Wpedantic -Wconversion -Wshadow -Wstrict-prototypes
OPT     ?= -O2

CFLAGS  += $(CSTD) $(WARN) $(OPT) -Iinclude

# The multiplexed endpoint is opt-in: `make MUX=1`. Off, its two files are
# not compiled, so a one-provider firmware carries none of it.
MUX     ?= 0
ifeq ($(MUX),1)
CFLAGS  += -DMCPB_ENABLE_MUX=1
MUX_SRCS := src/mcpb_envelope.c src/mcpb_mux.c
else
MUX_SRCS :=
endif
# Header dependency sidecars, so editing mcpb_port.h rebuilds what includes it.
CFLAGS  += -MMD -MP

BUILD   := build
LIB     := $(BUILD)/libmcpb.a

SRCS    := $(filter-out src/mcpb_envelope.c src/mcpb_mux.c,$(wildcard src/*.c)) $(MUX_SRCS)
OBJS    := $(patsubst src/%.c,$(BUILD)/%.o,$(SRCS))
DEPS    := $(OBJS:.o=.d) $(BUILD)/test_mcpb.d

TEST_SRC := tests/test_mcpb.c
TEST_BIN := $(BUILD)/test_mcpb

.PHONY: all test clean

all: $(LIB)

$(LIB): $(OBJS)
	@mkdir -p $(@D)
	$(AR) rcs $@ $(OBJS)

$(BUILD)/%.o: src/%.c
	@mkdir -p $(@D)
	$(CC) $(CFLAGS) -c $< -o $@

# The bench includes src/mcpb_internal.h to reach SHA-1 and base64 directly,
# so it compiles against the sources rather than only the public headers.
$(TEST_BIN): $(TEST_SRC) $(OBJS)
	@mkdir -p $(@D)
	$(CC) $(CFLAGS) $(TEST_SRC) $(OBJS) -o $@

test: $(TEST_BIN)
	@./$(TEST_BIN)

clean:
	rm -rf $(BUILD)

-include $(DEPS)
