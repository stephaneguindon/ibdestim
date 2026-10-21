import math
import random
import numpy as np
import pandas as pd
import argparse

def reflected_uniform(xy0, l):
	return 1.0 / l**2


def rw_2d_reflected_continuous_time(xy1, xy0, m, l, lambda_, t):
	l = abs(math.floor(l))
	if l == 0:
		return 0.0

	x0 = xy0[0] * (l - 1) + 1
	y0 = xy0[1] * (l - 1) + 1
	x1 = xy1[0] * (l - 1) + 1
	y1 = xy1[1] * (l - 1) + 1

	lk = math.exp(-(x0 - round(x0)) ** 2)
	lk *= math.exp(-(y0 - round(y0)) ** 2)
	lk *= math.exp(-(x1 - round(x1)) ** 2)
	lk *= math.exp(-(y1 - round(y1)) ** 2)

	if x0 > l or y0 > l or x1 > l or y1 > l:
		print(f" raw x0: {xy0[0]} y0: {xy0[1]} x1: {xy1[0]} y1: {xy1[1]}")
		print(f" x0: {x0} y0: {y0} x1: {x1} y1: {y1} l: {l}")
		print(" ++ Warning: coordinates outside of grid, returning 0 probability !!")
		return 0.0

	if x0 < 1 or y0 < 1 or x1 < 1 or y1 < 1:
		print(f" raw x0: {xy0[0]} y0: {xy0[1]} x1: {xy1[0]} y1: {xy1[1]}")
		print(f" x0: {x0} y0: {y0} x1: {x1} y1: {y1} l: {l}")
		print(" -- Warning: coordinates outside of grid, returning 0 probability !!")
		return 0.0

	modes = np.arange(1, l, dtype=float)
	cos_modes = np.cos(np.pi * modes / l)
	x_sum = np.sum(
		np.exp(-m / 2 * lambda_ * t * (1 - cos_modes))
		* np.cos(np.pi * modes * (0.5 - x0) / l)
		* np.cos(np.pi * modes * (0.5 - x1) / l)
	)
	y_sum = np.sum(
		np.exp(-m / 2 * lambda_ * t * (1 - cos_modes))
		* np.cos(np.pi * modes * (0.5 - y0) / l)
		* np.cos(np.pi * modes * (0.5 - y1) / l)
	)

	modes_x = modes[:, np.newaxis]
	modes_y = modes[np.newaxis, :]
	cos_x = np.cos(np.pi * modes_x / l)
	cos_y = np.cos(np.pi * modes_y / l)
	xy_sum = np.sum(
		np.exp(-m / 2 * lambda_ * t * (2 - cos_x - cos_y))
		* np.cos(np.pi * modes_x * (0.5 - x0) / l)
		* np.cos(np.pi * modes_x * (0.5 - x1) / l)
		* np.cos(np.pi * modes_y * (0.5 - y0) / l)
		* np.cos(np.pi * modes_y * (0.5 - y1) / l)
	)

	lk *= 1 / l**2 + 2 / l**2 * x_sum + 2 / l**2 * y_sum + 4 / l**2 * xy_sum
	if lk < 1e-10:
		lk = 1e-10

	with np.errstate(divide="ignore", invalid="ignore"):
		log_lk = np.log(lk)
	if np.isnan(log_lk):
		lk = 0.0
		print(
			f"Nan detected... {t} {xy1[0]} {xy1[1]} {xy0[0]} {xy0[1]} "
			f"{m} {l} {lambda_}"
		)
	if np.isinf(log_lk):
		print(
			f"-Inf detected... {t} {xy1[0]} {xy1[1]} {xy0[0]} {xy0[1]} "
			f"{m} {l} {lambda_}"
		)
	return float(lk)


def ibd_lk_one_pair(p):
	t, x1, y1, x2, y2, m, l, lambda_ = p

	space = rw_2d_reflected_continuous_time(
		(x1, y1), (x2, y2), m, l, lambda_, 2 * t
	)
	space *= reflected_uniform((x1, y1), l)
	space *= l**4

	L = (l - 2) ** 2 / l**2 + 8 * (l - 2) / l**2 + 16 / l**2
	euler_gamma = 0.577215664901532860
	with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
		rate = -1 / l**2 * np.log(
			1
			- (2 * np.pi * m * lambda_)
			/ (2 * np.pi * m * lambda_ + L * (euler_gamma + np.log(l**2)))
		)
		time = rate * np.exp(-rate * t)

		# if np.isinf(np.log(space)) or np.isinf(np.log(time)):
		# 	print(f" *  m= {m} l= {l}")

		if space > 0 and time > 0:
			return float(np.log(space) + np.log(time))
	return -1e20


def ibd_lk(params, data):	
  m, l = params[0], params[1]
  pairs = zip(data["t"], data["x1"], data["y1"], data["x2"], data["y2"])
  return sum(
		ibd_lk_one_pair((t, x1, y1, x2, y2, m, l, 1))
		for t, x1, y1, x2, y2 in pairs
	)


random.seed()
parser = argparse.ArgumentParser(description="Estimate migration and population size parameters under a 2D continuous-time reflected random walk model.")
parser.add_argument("--input-file", "--input_file", default="/tmp/coalescent_times.txt",
                    help="path to the input file (default: /tmp/coalescent_times.txt)")
parser.add_argument("--output-file", "--output_file", default="/tmp/ibd_results.txt",
                    help="path to the output file (default: /tmp/ibd_results.txt)")
parser.add_argument("--n-subsamples", "--subsample_size", type=int, default=100,
                    help="subsample size (default: 100)")
args = parser.parse_args()

input_file = args.input_file
output_file = args.output_file
subsample_size = args.n_subsamples

print(f"Running maximum-likelihood estimation for data in file {input_file}")
print(f"Results will be saved to file {output_file}")

data = pd.read_csv(input_file, sep="\t")
print(f"Loaded {data.shape[0]} data points")
print(f"Subsampling data to {subsample_size} points")


data.columns = ["x1", "y1", "x2", "y2", "t"]
data["t"] = data["t"].astype(float)
data["x1"] = data["x1"].astype(float)
data["y1"] = data["y1"].astype(float)
data["x2"] = data["x2"].astype(float)
data["y2"] = data["y2"].astype(float)

for column in ("x1", "y1", "x2", "y2"):
	data[column] = (data[column] - data[column].min()) / (
		data[column].max() - data[column].min()
	)


# take the first subsample_size rows of the data
data = data.loc[:(subsample_size - 1)]

# data = data.sample(n=subsample_size)

m = np.arange(0.01, 1.0, 0.05)
l = np.arange(15, 200, 5)

lk = np.zeros((len(m),len(l)))


for i in range(len(m)):
  for j in range(len(l)):
    lk[i,j] = ibd_lk((m[i],l[j]),data)
    print(f"Pre-calculation step... m={m[i]:.2f} l={l[j]} lk={lk[i,j]}", end="\r")

# flatten the lk array and get the corresponding values of m and l
lk = lk.flatten()
lenm = len(m)
m = np.repeat(m, len(l))
l = np.repeat(l, lenm)


sorted_indices = (-lk).argsort()
lk = lk[sorted_indices]
m = m[sorted_indices]
l = l[sorted_indices]

# # keep the first 20% of lk values
# lk = lk[:int(0.5*len(lk))]
# m = m[:int(0.5*len(lk))]
# l = l[:int(0.5*len(lk))]

iter = 0

while(lk[0] - lk[int(0.8*len(lk))] > 1):
  iter += 1
  # normalize lk values to sum up to one
  p = np.exp(lk-lk.max())
  p = p / sum(p)
	# random draw of indices using lk as weights
  idx = np.random.choice(len(lk), size=len(lk), p=p)
	
  # save the values of m and l corresponding to the indices
  m = m[idx]
  l = l[idx]
  
  # add noise to the values of m and l
  m = m + np.random.normal(0, m/5, len(m))
	# set minimum value of m to 0.05
  m = np.maximum(m, 0.05)
	# set maximum value of m to 1.00
  m = np.minimum(m, 1.00)
	
  l = l + np.random.normal(0, l/10, len(l))
  l = l.astype(int)
  # set minimum value of l to 10
  l = np.maximum(l, 15)
	
  # compute lk for the new values of m and l
  for i in range(len(m)):
    lk[i] = ibd_lk((m[i],l[i]),data)
  
  # rank the values of lk in decreasing order and save the corresponding values of m and l
  sorted_indices = (-lk).argsort()
  lk = lk[sorted_indices]
  m = m[sorted_indices]
  l = l[sorted_indices]
	# print mean lk values and delta lk
  print(f"Mean lk: {lk.mean():.2f} mean(m): {m.mean():.2f} mean(l): {l.mean():4.0f} delta lk: {(lk[0] - lk[int(0.8*len(lk))]):.2f}", end="\r")

  # Save results to file
  with open(output_file, "a") as f:
    if(iter == 1): f.write("iter m l lk\n")
    for i in range(len(m)):
      f.write(f"{iter} {m[i]:.2f} {l[i]:.2f} {lk[i]:.2f}\n")
    f.close