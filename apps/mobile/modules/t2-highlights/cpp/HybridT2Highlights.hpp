#pragma once

#include "HybridT2HighlightsSpec.hpp"

namespace margelo::nitro::t2highlights {

class HybridT2Highlights : public HybridT2HighlightsSpec {
public:
  HybridT2Highlights() : HybridObject(TAG) {}

  std::optional<std::shared_ptr<ArrayBuffer>> tokenize(SourceText source,
                                                       double language) override;
};

} // namespace margelo::nitro::t2highlights
