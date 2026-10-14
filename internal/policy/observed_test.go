package policy

import (
	"math"
	"testing"
	"unicode/utf8"

	"github.com/rafaelperoco/secretgenerator/internal/charset"
)

func TestObserve_Empty(t *testing.T) {
	got := Observe("")
	if got.Classes != 0 || got.AlphabetSize != 0 || got.RuneLength != 0 || got.CharsetID != "empty" {
		t.Errorf("empty = %+v", got)
	}
}

func TestObserve_ASCIIClasses(t *testing.T) {
	tests := []struct {
		in   string
		want string
		size int
	}{
		{"abc", "lower", 26},
		{"ABC", "upper", 26},
		{"123", "digit", 10},
		{"!@#", "symbol", 32},
		{"abcDEF", "lower,upper", 52},
		{"Abc1", "lower,upper,digit", 62},
		{"Abc1!", "lower,upper,digit,symbol", 94},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got := Observe(tt.in)
			if ClassesString(got.Classes) != tt.want {
				t.Errorf("classes = %q, want %q", ClassesString(got.Classes), tt.want)
			}
			if got.AlphabetSize != tt.size {
				t.Errorf("size = %d, want %d", got.AlphabetSize, tt.size)
			}
			if got.RuneLength != len(tt.in) {
				t.Errorf("runes = %d, want %d", got.RuneLength, len(tt.in))
			}
		})
	}
}

func TestObserve_CountsRunesNotBytes(t *testing.T) {
	// "é" is one code point and two UTF-8 bytes. Counting bytes would
	// report twice the entropy of the character model.
	const pw = "é"
	if utf8.RuneCountInString(pw) != 1 || len(pw) != 2 {
		t.Fatalf("fixture encoding changed: runes=%d bytes=%d", utf8.RuneCountInString(pw), len(pw))
	}
	got := Observe(pw)
	if got.RuneLength != 1 {
		t.Errorf("runes = %d, want 1", got.RuneLength)
	}
	if got.Classes != charset.ClassSymbol || got.AlphabetSize != asciiPunctuationSize {
		t.Errorf("classes/size = %b/%d, want symbol/%d", got.Classes, got.AlphabetSize, asciiPunctuationSize)
	}
	wantBits := math.Log2(float64(asciiPunctuationSize))
	if math.Abs(got.Bits-wantBits) > 1e-9 {
		t.Errorf("bits = %v, want %v", got.Bits, wantBits)
	}

	mixed := Observe("héllo")
	if mixed.RuneLength != 5 {
		t.Errorf("héllo runes = %d, want 5", mixed.RuneLength)
	}
	if mixed.AlphabetSize != 26+asciiPunctuationSize {
		t.Errorf("héllo size = %d, want %d", mixed.AlphabetSize, 26+asciiPunctuationSize)
	}
}
