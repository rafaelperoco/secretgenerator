// Package limits bounds credential sizes so an unbounded request from an
// agent cannot exhaust memory. The caps sit far above any real policy.
package limits

import (
	"errors"
	"fmt"
)

// ErrLimit is returned when a requested size is outside the accepted range.
var ErrLimit = errors.New("limits: value out of range")

const (
	// MaxPasswordLength bounds password and API-key bodies, in runes.
	MaxPasswordLength = 4096

	// MaxSecretBytes bounds raw CSPRNG output. 1 MiB is 2^23 bits.
	MaxSecretBytes = 1 << 20

	// MaxPassphraseWords bounds diceware draws.
	MaxPassphraseWords = 256

	// MaxPINDigits bounds numeric PINs. Longer values are secrets, not PINs.
	MaxPINDigits = 32
)

// CheckPositive reports whether n is in 1..max.
func CheckPositive(n, max int, name string) error {
	if n <= 0 || n > max {
		return fmt.Errorf("%w: %s must be in 1..%d, got %d", ErrLimit, name, max, n)
	}
	return nil
}
