import math
import random
import numpy as np
import pandas as pd
import argparse
import os

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
	# rate = 1 / l**2
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
parser.add_argument("--output-file", "--output_file", nargs="?", const=None, default=None,
                    help="optional path to save iteration results (default: print only)")
parser.add_argument("--sampling_prop", "--sample_prop", type=float, default=1.0,
                    help="sub-sampling proportion (default: 0.5)")
parser.add_argument("--l_max", "--max_l", type=float, default=250,
                    help="maximum population size (default: 250)")
parser.add_argument("--l_min", "--min_l", type=float, default=10,
                    help="minimum population size (default: 10)")

args = parser.parse_args()

input_file = args.input_file
output_file = args.output_file

if output_file is not None:
	try:
		os.remove(output_file)
		print(f"Output file deleted successfully: {output_file}")
	except FileNotFoundError:
		pass


print(f"Running maximum-likelihood estimation for data in file {input_file}")
if output_file is not None:
	print(f"Results will be saved to file {output_file}")

data = pd.read_csv(input_file, sep="\t")
subsample_size = int(args.sampling_prop * data.shape[0])
print(f"Loaded {data.shape[0]} data points")
print(f"Sub-sampling proportion: {args.sampling_prop}")
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


# sample unifromly at random subsample_size rows of the data
data = data.sample(n=subsample_size)

m = np.linspace(0.01, 1.0, 20)
l = np.linspace(args.l_min, args.l_max, 20)
l = np.round(l,0)

lenm = len(m)
lenl = len(l)

m = np.repeat(m, lenl)
l = np.tile(l, lenm)
lk = np.repeat(-np.inf, lenm*lenl)

iter = 0
for i in range(len(m)):
  lk[i] = ibd_lk((m[i],l[i]),data)
  print(f"Pre-calculation steps... m={m[i]:7.3f} l={int(l[i]):5d} lk={lk[i]:15.6g}", end="\r")
  if output_file is not None:
    with open(output_file, "a") as f:
      if(iter == 1): f.write("iter m l lk\n")
      for i in range(len(m)):
        f.write(f"{iter} {m[i]} {l[i]} {lk[i]}\n")

# rank the values of lk in decreasing order and save the corresponding values of m and l
sorted_indices = (-lk).argsort()
lk = lk[sorted_indices]
m = m[sorted_indices]
l = l[sorted_indices]

current_mean = np.mean(lk)
previous_mean = 0.0

keep_frac = 0.7;

while(abs(current_mean - previous_mean) > 0.5):
  iter += 1
  
  if output_file is not None:
    with open(output_file, "a") as f:
      if(iter == 1): f.write("iter m l lk\n")
      for i in range(len(m)):
        f.write(f"{iter} {m[i]} {l[i]} {lk[i]}\n")
  
  for i in range(int(keep_frac*len(m)),len(m),1):
    ref = np.random.randint(0,int(keep_frac*len(m)))
    m[i] = m[ref] + np.random.normal(0, m[ref]/8)
    l[i] = l[ref] + np.random.normal(0, l[ref]/8)
		
    m[i] = np.maximum(m[i], 0.01)
    m[i] = np.minimum(m[i], 1.00)

    l[i] = l[i].astype(int)
    l[i] = np.maximum(l[i], 10)

    lk[i] = ibd_lk((m[i],l[i]),data)
	
  
  # rank the values of lk in decreasing order and save the corresponding values of m and l
  sorted_indices = (-lk).argsort()
  lk = lk[sorted_indices]
  m = m[sorted_indices]
  l = l[sorted_indices]

  previous_mean = current_mean
  current_mean = np.mean(lk)

	# print optimal values of parameters	
  print(f"Iter: {iter:5d} <> max. log(lk): {lk[0]:15.6g} mean log(lk): {current_mean:15.6g} optimal m: {m[0]:.2f} optimal l: {l[0]:5.0f} delta log(lk): {abs(current_mean - previous_mean):6.2g}", end="\n")

print(f"Final estimates <> m: {m[0]:.2f} l: {l[0]:5.0f}", end="\n")
