package policy

import (
	"strings"
	"unicode"

	"github.com/rafaelperoco/secretgenerator/internal/charset"
)

// asciiPunctuationSize is the count of ASCII punctuation code points
// (U+0021–U+007E, excluding letters and digits). symbol-v1 is a 31-rune
// subset that omits the double quote. The estimator keeps 32 so a
// credential that contains that quote is still bounded by the ASCII
// punctuation class, and the result stays an upper bound.
const asciiPunctuationSize = 32

// Observed is the class-uniform upper bound for an existing credential.
// RuneLength counts Unicode code points. A multi-byte character is one
// draw; counting bytes would inflate the bound (a single emoji is four
// UTF-8 bytes and would look four times stronger than it is).
type Observed struct {
	RuneLength   int
	Classes      charset.Class
	AlphabetSize int
	Bits         float64
	CharsetID    string
}

// Observe estimates the Shannon upper bound of s, assuming each rune was
// drawn uniformly from the ASCII classes present in s. Non-ASCII runes
// count as the punctuation class. Real entropy is lower when s is a
// dictionary word, a date, or any other memorable pattern.
func Observe(s string) Observed {
	var classes charset.Class
	n := 0
	for _, r := range s {
		n++
		switch {
		case unicode.IsLower(r) && r <= 0x7F:
			classes |= charset.ClassLower
		case unicode.IsUpper(r) && r <= 0x7F:
			classes |= charset.ClassUpper
		case r >= '0' && r <= '9':
			classes |= charset.ClassDigit
		default:
			classes |= charset.ClassSymbol
		}
	}
	size := observedAlphabetSize(classes)
	return Observed{
		RuneLength:   n,
		Classes:      classes,
		AlphabetSize: size,
		Bits:         EntropyBits(n, size),
		CharsetID:    observedCharsetID(classes),
	}
}

func observedAlphabetSize(c charset.Class) int {
	size := 0
	if c&charset.ClassLower != 0 {
		size += 26
	}
	if c&charset.ClassUpper != 0 {
		size += 26
	}
	if c&charset.ClassDigit != 0 {
		size += 10
	}
	if c&charset.ClassSymbol != 0 {
		size += asciiPunctuationSize
	}
	return size
}

func observedCharsetID(c charset.Class) string {
	parts := make([]string, 0, 4)
	if c&charset.ClassLower != 0 {
		parts = append(parts, "lower")
	}
	if c&charset.ClassUpper != 0 {
		parts = append(parts, "upper")
	}
	if c&charset.ClassDigit != 0 {
		parts = append(parts, "digit")
	}
	if c&charset.ClassSymbol != 0 {
		parts = append(parts, "symbol")
	}
	if len(parts) == 0 {
		return "empty"
	}
	return "observed:" + strings.Join(parts, "+")
}
